import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "../client";
import balanceFixture from "../fixtures/balance.2026-11-26.json";
import toolsFixture from "../fixtures/tools-list.2026-11-26.json";

// ---------------------------------------------------------------------------
// BL-278 (VIDIQ_INTEGRATION_PLAN.md §7): a fake of vidIQ's MCP server for tests only, reached through an injected `fetch`
// (`createVidiqGateway({ endpoint: fake.url, fetch: fake.fetch })`), never through a socket. The SDK's low-level `Server` over its
// Web-standard Streamable HTTP transport, a new Server and transport per request (stateless, JSON answers), as
// `producer-mcp-endpoint` does. `tools/list` answers the dated fixture verbatim (or a per-test mutation); `tools/call` answers a
// per-test script. Auth, HTTP failures and hangs are handled before the MCP layer, which also records every request so a test can
// assert what was (and was not) sent. Never imported by production code.
//
// Why in-process (2026-11-28): the first version listened on 127.0.0.1 and the gateway reached it with the real global `fetch`, so
// every test depended on the shared undici connection pool and the machine's loopback TCP state; under a loaded full-suite run an
// operation could stall for the length of a timeout and fail before its `tools/call` went out (a flaky `vidiq_unavailable`). Here a
// request is a function call: it answers as soon as the test's script says, and a "hang" is a promise that settles only when the
// client aborts the request (as `fetch` does), so a timeout test depends on its own timeout alone. `fake.url` is a loopback URL on
// port 1, where nothing listens: a gateway that ignored the injected `fetch` would fail at once instead of reaching anything.
//
// Its failure bodies (401/429/5xx) and its `isError` results echo the Authorization header it received, so a test proves the
// gateway never passes a transport error's text (which embeds the response body) on to a log, an answer or the ledger.
// ---------------------------------------------------------------------------

export type FakeToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

/** One scripted answer to a `tools/call`. */
export type FakeCallAnswer =
  | { result: FakeToolResult; delayMs?: number }
  | { http: number; headers?: Record<string, string>; delayMs?: number }
  | { delayMs: number; hang: true }
  /** A JSON-RPC error answer (HTTP 200); its message echoes the Authorization header, so a leaked error text is detectable. */
  | { rpcError: number; delayMs?: number };

export type FakeRequestRecord = {
  httpMethod: string;
  rpcMethod: string | null;
  tool: string | null;
  args: unknown;
  authorization: string | null;
};

export type FakeVidiqServer = {
  /** A loopback URL nothing listens on; requests reach the fake only through `fetch`. */
  url: string;
  /** Pass as the gateway's `fetch`. */
  fetch: FetchLike;
  requests: FakeRequestRecord[];
  toolCalls(): FakeRequestRecord[];
  /** Replaces the `tools/list` answer (a deep copy of the fixture by default). */
  tools: Array<Record<string, unknown>>;
  /** Per-tool scripted answers; a tool with no script answers `paidResult(0)`. */
  script: Map<string, (args: Record<string, unknown>) => FakeCallAnswer>;
  /** An HTTP failure for `tools/list`, or no answer at all (null = answer normally). */
  listFailure: { http: number; headers?: Record<string, string> } | { hang: true } | null;
  /** Fails every request still waiting (a hang or a delay) as aborted. */
  close(): Promise<void>;
};

export const FIXTURE_TOOLS = toolsFixture as Array<Record<string, unknown>>;
export const FIXTURE_BALANCE = balanceFixture as unknown as FakeToolResult;

export function fixtureToolsCopy(): Array<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(FIXTURE_TOOLS)) as Array<Record<string, unknown>>;
}

/** A result with `_credits.used` in both the structured content and the text, as vidIQ answers. */
export function paidResult(used: number, data: Record<string, unknown> = { items: [] }, isError = false): FakeToolResult {
  const body = { ...data, _credits: { used } };
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, ...(isError ? { isError: true } : {}) };
}

/** A balance result shaped like the fixture, with chosen numbers. */
export function balanceResult(totalCredits: number, renewableResetsAt = "2026-12-26T14:01:17.657045Z"): FakeToolResult {
  const body = { type: "limited", totalCredits, renewableCredits: totalCredits, maxRenewableCredits: 150, renewableResetsAt, addOnCredits: 0, maxAddOnCredits: 0, _credits: { used: 0 } };
  return { _meta: { widgetData: { ...body, planName: "Free" } }, content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
}

const FAKE_URL = "http://127.0.0.1:1/mcp";

function abortError(): Error {
  return new DOMException("This operation was aborted", "AbortError");
}

export async function startFakeVidiqServer(options: { acceptKey: string }): Promise<FakeVidiqServer> {
  const requests: FakeRequestRecord[] = [];
  /** Requests waiting on a delay or a hang; `close` fails them. */
  const waiting = new Set<() => void>();
  const state: FakeVidiqServer = {
    url: FAKE_URL,
    fetch: async () => {
      throw new Error("replaced below");
    },
    requests,
    toolCalls: () => requests.filter((r) => r.rpcMethod === "tools/call"),
    tools: fixtureToolsCopy(),
    script: new Map(),
    listFailure: null,
    close: async () => undefined,
  };
  state.script.set("vidiq_balance", () => ({ result: FIXTURE_BALANCE }));

  /**
   * Resolves after `ms` (or never, for `ms === null`); rejects as aborted when the client's signal aborts or the fake closes. A
   * delay is a timer, but no test's outcome depends on how long it takes, only on the order it imposes.
   */
  function wait(signal: AbortSignal | null | undefined, ms: number | null): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fail = () => {
        cleanup();
        reject(abortError());
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", fail);
        waiting.delete(fail);
      };
      signal?.addEventListener("abort", fail, { once: true });
      waiting.add(fail);
      if (ms !== null) {
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, ms);
      }
    });
  }

  function fail(status: number, authorization: string | null, headers: Record<string, string> = {}): Response {
    return new Response(`refused, received authorization: ${authorization ?? "(none)"}`, { status, headers: { "content-type": "text/plain", ...headers } });
  }

  async function handle(url: string, init: RequestInit | undefined): Promise<Response> {
    const signal = init?.signal ?? null;
    if (signal?.aborted) throw abortError();
    if (url !== FAKE_URL) throw new TypeError(`fake vidIQ: unexpected URL ${url}`);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    const text = method === "POST" ? (typeof init?.body === "string" ? init.body : "") : "";
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const message = (Array.isArray(parsed) ? parsed[0] : parsed) as { method?: string; params?: { name?: string; arguments?: unknown } } | undefined;
    const rpcMethod = typeof message?.method === "string" ? message.method : null;
    const tool = rpcMethod === "tools/call" && typeof message?.params?.name === "string" ? message.params.name : null;
    requests.push({ httpMethod: method, rpcMethod, tool, args: rpcMethod === "tools/call" ? message?.params?.arguments : undefined, authorization });

    if (method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (authorization !== `Bearer ${options.acceptKey}`) return fail(401, authorization);
    const listFailure = rpcMethod === "tools/list" ? state.listFailure : null;
    if (listFailure && "hang" in listFailure) await wait(signal, null); // never answers: the client's list timeout fires and aborts
    else if (listFailure) return fail(listFailure.http, authorization, listFailure.headers);

    let answer: FakeCallAnswer | null = null;
    if (rpcMethod === "tools/call" && tool) {
      const scripted = state.script.get(tool);
      const args = (message?.params?.arguments ?? {}) as Record<string, unknown>;
      answer = scripted ? scripted(args) : { result: paidResult(0) };
      if ("hang" in answer) await wait(signal, null); // never answers: the client times out after sending
      if (answer.delayMs) await wait(signal, answer.delayMs);
      if ("http" in answer) return fail(answer.http, authorization, answer.headers);
    }

    const server = new Server({ name: "vidiq-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: state.tools as never }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      if (answer && "rpcError" in answer) throw new McpError(answer.rpcError, `tool failed, received authorization: ${authorization}`);
      const result = answer && "result" in answer ? answer.result : paidResult(0);
      if (result.isError) {
        // The echo makes a leaked tool-error text detectable.
        return { ...result, content: [...result.content, { type: "text" as const, text: `received authorization: ${authorization}` }] } as never;
      }
      return result as never;
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(new Request(url, { method, headers, body: text }), { parsedBody: parsed });
      // The whole answer is read here, so nothing of this request stays open after it returns.
      const body = response.status === 202 || response.status === 204 ? null : await response.arrayBuffer();
      if (signal?.aborted) throw abortError();
      return new Response(body, { status: response.status, headers: response.headers });
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  state.fetch = (input, init) => handle(String(input), init);
  state.close = async () => {
    for (const abort of [...waiting]) abort();
  };
  return state;
}
