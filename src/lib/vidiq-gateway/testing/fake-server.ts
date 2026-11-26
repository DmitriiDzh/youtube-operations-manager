import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import balanceFixture from "../fixtures/balance.2026-11-26.json";
import toolsFixture from "../fixtures/tools-list.2026-11-26.json";

// ---------------------------------------------------------------------------
// BL-278 (VIDIQ_INTEGRATION_PLAN.md §7): a local fake of vidIQ's MCP server for tests only. The SDK's low-level `Server` over
// Streamable HTTP on 127.0.0.1 with an ephemeral port; a new Server and transport per request (stateless, JSON answers), as
// `producer-mcp-endpoint` does. `tools/list` answers the dated fixture verbatim (or a per-test mutation); `tools/call` answers a
// per-test script. Auth, HTTP failures and delays are handled in the node:http layer, which also records every request so a test
// can assert what was (and was not) sent. Never imported by production code.
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
  | { delayMs: number; hang: true };

export type FakeRequestRecord = {
  httpMethod: string;
  rpcMethod: string | null;
  tool: string | null;
  args: unknown;
  authorization: string | null;
};

export type FakeVidiqServer = {
  url: string;
  requests: FakeRequestRecord[];
  toolCalls(): FakeRequestRecord[];
  /** Replaces the `tools/list` answer (a deep copy of the fixture by default). */
  tools: Array<Record<string, unknown>>;
  /** Per-tool scripted answers; a tool with no script answers `paidResult(0)`. */
  script: Map<string, (args: Record<string, unknown>) => FakeCallAnswer>;
  /** An HTTP failure for `tools/list` (null = answer normally). */
  listFailure: { http: number; headers?: Record<string, string> } | null;
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeVidiqServer(options: { acceptKey: string }): Promise<FakeVidiqServer> {
  const requests: FakeRequestRecord[] = [];
  const state: FakeVidiqServer = {
    url: "",
    requests,
    toolCalls: () => requests.filter((r) => r.rpcMethod === "tools/call"),
    tools: fixtureToolsCopy(),
    script: new Map(),
    listFailure: null,
    close: async () => undefined,
  };
  state.script.set("vidiq_balance", () => ({ result: FIXTURE_BALANCE }));

  function fail(res: ServerResponse, status: number, authorization: string | null, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "text/plain", ...headers });
    res.end(`refused, received authorization: ${authorization ?? "(none)"}`);
  }

  const http = createServer(async (req, res) => {
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : null;
    const text = req.method === "POST" ? await readBody(req) : "";
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const message = (Array.isArray(parsed) ? parsed[0] : parsed) as { method?: string; params?: { name?: string; arguments?: unknown } } | undefined;
    const rpcMethod = typeof message?.method === "string" ? message.method : null;
    const tool = rpcMethod === "tools/call" && typeof message?.params?.name === "string" ? message.params.name : null;
    requests.push({ httpMethod: req.method ?? "", rpcMethod, tool, args: rpcMethod === "tools/call" ? message?.params?.arguments : undefined, authorization });

    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    if (authorization !== `Bearer ${options.acceptKey}`) return fail(res, 401, authorization);
    if (rpcMethod === "tools/list" && state.listFailure) return fail(res, state.listFailure.http, authorization, state.listFailure.headers);

    let answer: FakeCallAnswer | null = null;
    if (rpcMethod === "tools/call" && tool) {
      const scripted = state.script.get(tool);
      const args = (message?.params?.arguments ?? {}) as Record<string, unknown>;
      answer = scripted ? scripted(args) : { result: paidResult(0) };
      if (answer.delayMs) await sleep(answer.delayMs);
      if ("hang" in answer) return; // never answers: the client times out after sending
      if ("http" in answer) return fail(res, answer.http, authorization, answer.headers);
    }

    const server = new Server({ name: "vidiq-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: state.tools as never }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      const result = answer && "result" in answer ? answer.result : paidResult(0);
      if (result.isError) {
        // The echo makes a leaked tool-error text detectable.
        return { ...result, content: [...result.content, { type: "text" as const, text: `received authorization: ${authorization}` }] } as never;
      }
      return result as never;
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}/mcp`;
  state.close = () =>
    new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    });
  return state;
}
