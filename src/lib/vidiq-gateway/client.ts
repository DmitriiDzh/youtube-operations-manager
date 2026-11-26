import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ErrorCode, ListToolsResultSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { DomainError } from "@/lib/shared-domain";

// ---------------------------------------------------------------------------
// BL-278 (ADR 0077 decision 1, VIDIQ_INTEGRATION_PLAN.md §5 stage 1): the one MCP client to vidIQ. Each operation opens a fresh
// SDK `Client` over `StreamableHTTPClientTransport`, does one thing and closes it; one operation in flight per process (a queue on
// `globalThis`, since the MCP route, the Web routes and other bundles are separate module instances); 60 s timeout.
//
// The URL is a constant, never a setting: the key can go only to vidIQ. Tests may point the gateway at a loopback server only
// (`index.ts`). Errors are mapped to DomainErrors with FIXED messages: a raw SDK or transport error is never logged or returned,
// because its text can carry the response body or request headers.
// ---------------------------------------------------------------------------

export const VIDIQ_MCP_URL = "https://mcp.vidiq.com/mcp";
export const VIDIQ_TIMEOUT_MS = 60_000;

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export type McpToolListEntry = { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> };
export type McpCallResult = { content?: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };

type Tracker = { rpcSent: boolean; status: number | null; retryAfterSeconds: number | null };

const QUEUE_KEY = Symbol.for("youtube-operations-manager.vidiq-gateway.queue");

/** One vidIQ operation at a time in this process. */
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const holder = globalThis as unknown as Record<symbol, Promise<unknown> | undefined>;
  const tail = holder[QUEUE_KEY] ?? Promise.resolve();
  const result = tail.then(run, run);
  holder[QUEUE_KEY] = result.catch(() => undefined);
  return result;
}

// Errors that mean the request never reached the server (nothing was processed there).
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ERR_INVALID_URL", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

function errorCodeOf(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.round((date - Date.now()) / 1000));
}

function classify(error: unknown, tracker: Tracker): DomainError {
  if (error instanceof DomainError) return error;
  const status = tracker.status;
  if (status === 401 || status === 403) return new DomainError({ code: "vidiq_key_invalid", message: "vidIQ refused the API key." });
  if (status === 429) {
    return new DomainError({
      code: "vidiq_rate_limited",
      message: "vidIQ asks to wait (rate limit).",
      details: { ...(tracker.retryAfterSeconds !== null ? { retryAfterSeconds: tracker.retryAfterSeconds } : {}), requestSent: tracker.rpcSent },
    });
  }
  if (status !== null && status >= 500) return new DomainError({ code: "vidiq_unavailable", message: "vidIQ is not available right now.", details: { requestSent: tracker.rpcSent } });
  const timedOut = (error instanceof McpError && error.code === ErrorCode.RequestTimeout) || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
  if (tracker.rpcSent && (timedOut || !NOT_SENT_CODES.has(errorCodeOf(error) ?? ""))) {
    // The call left and no usable answer came back: vidIQ may have charged it.
    if (timedOut || !(error instanceof McpError)) {
      return new DomainError({ code: "vidiq_outcome_unknown", message: "vidIQ did not answer in time; the call may have been charged.", details: { requestSent: true } });
    }
    return new DomainError({ code: "vidiq_unavailable", message: "vidIQ answered with an error.", details: { requestSent: true } });
  }
  return new DomainError({ code: "vidiq_unavailable", message: "vidIQ cannot be reached right now.", details: { requestSent: false } });
}

/**
 * `connectTimeoutMs`: the handshake and `tools/list`. `timeoutMs`: one `tools/call` from the moment it is sent, so a timeout of
 * that call always means "sent, outcome unknown".
 */
export type McpOperationOptions = { url: URL; key: string; timeoutMs: number; connectTimeoutMs: number; fetchImpl: FetchLike };

/**
 * Runs one operation on a fresh, connected client. `trackRpc` names the JSON-RPC method whose dispatch decides whether a later
 * failure is "unknown" (the call left) or "unavailable" (nothing was sent).
 */
async function withClient<T>(options: McpOperationOptions, trackRpc: string, operation: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
  return enqueue(async () => {
    const tracker: Tracker = { rpcSent: false, status: null, retryAfterSeconds: null };
    const controller = new AbortController();
    const trackedFetch: FetchLike = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      const isPost = (init?.method ?? "GET").toUpperCase() === "POST";
      const isTracked = isPost && body.includes(`"method":"${trackRpc}"`);
      if (isTracked) {
        tracker.rpcSent = true;
        tracker.status = null; // only the tracked request's own answer decides
      }
      try {
        const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
        const response = await options.fetchImpl(url, { ...init, signal });
        if (isPost) {
          tracker.status = response.status;
          tracker.retryAfterSeconds = response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : null;
        }
        return response;
      } catch (error) {
        if (isTracked && NOT_SENT_CODES.has(errorCodeOf(error) ?? "")) tracker.rpcSent = false;
        throw error;
      }
    };
    const transport = new StreamableHTTPClientTransport(options.url, {
      requestInit: { headers: { Authorization: `Bearer ${options.key}` } },
      fetch: trackedFetch,
    });
    const client = new Client({ name: "ytm-vidiq-gateway", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: options.connectTimeoutMs, signal: controller.signal });
      return await operation(client, controller.signal);
    } catch (error) {
      throw classify(error, tracker);
    } finally {
      controller.abort();
      await client.close().catch(() => undefined);
    }
  });
}

/** `tools/list`, every page (at most 20). Free. */
export function mcpListTools(options: McpOperationOptions): Promise<McpToolListEntry[]> {
  return withClient(options, "tools/list", async (client, signal) => {
    const tools: McpToolListEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await client.request({ method: "tools/list", params: cursor ? { cursor } : {} }, ListToolsResultSchema, { timeout: options.connectTimeoutMs, signal });
      tools.push(...(result.tools as McpToolListEntry[]));
      cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  });
}

/**
 * One `tools/call` through `client.request` (never `client.callTool`, which validates the result against an output schema cached by
 * an earlier list and would throw AFTER vidIQ charged the call).
 */
export function mcpCallTool(options: McpOperationOptions, name: string, args: Record<string, unknown>): Promise<McpCallResult> {
  return withClient(options, "tools/call", async (client, signal) => {
    const result = await client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema, { timeout: options.timeoutMs, signal });
    return result as McpCallResult;
  });
}
