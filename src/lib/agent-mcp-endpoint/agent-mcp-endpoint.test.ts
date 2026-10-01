import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createMcpServer } from "@/mcp/server";
import { MCP_TOOL_CLASSIFICATION } from "@/mcp/tool-classification";
import { DomainError } from "@/lib/shared-domain";
import { getAgentSession } from "@/lib/agent-session";
import type { AgentTokenBinding } from "@/lib/agent-tokens";
import { createAgentMcpEndpoint } from "./index";
import { isLoopbackRequest } from "./loopback";

// Expected behaviour is stated by hand from docs/roadmap/plans/HTTP_MCP_SERVER_PLAN.md §3
// (AC-HM-01..06, 10, 12, 13), written before the endpoint module.

const BINDING_A: AgentTokenBinding = { tokenId: "tok-a", channelId: "UC_A", userId: "user-a" };
const BINDING_B: AgentTokenBinding = { tokenId: "tok-b", channelId: "UC_B", userId: "user-b" };

function setup(initial: { enabled?: boolean } = {}) {
  const tokens = new Map<string, AgentTokenBinding>([
    ["token-a", BINDING_A],
    ["token-b", BINDING_B],
  ]);
  const state = { enabled: initial.enabled ?? true, createdServers: 0 };
  const endpoint = createAgentMcpEndpoint({
    isConnectionEnabled: async () => state.enabled,
    verifyToken: async (token) => {
      const binding = tokens.get(token);
      if (!binding) throw new DomainError({ code: "AGENT_TOKEN_INVALID", message: "unknown" });
      return binding;
    },
    createServer: (options) => {
      state.createdServers++;
      return createMcpServer(undefined, options);
    },
  });
  return { endpoint, tokens, state };
}

function rpc(body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("http://127.0.0.1:3000/api/mcp", {
    method,
    headers: {
      host: "127.0.0.1:3000",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

const LIST_TOOLS = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const withToken = (token: string) => ({ authorization: `Bearer ${token}` });

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return (await response.json()).error;
}

// ---- AC-HM-01: loopback guard -------------------------------------------------------------

test("AC-HM-01: loopback Host values are accepted, with or without a port", () => {
  for (const host of ["127.0.0.1", "127.0.0.1:3000", "localhost", "localhost:3000", "LOCALHOST:3000", "[::1]", "[::1]:3000"]) {
    assert.equal(isLoopbackRequest(new Headers({ host })), true, host);
  }
});

test("AC-HM-01: a non-loopback, missing or malformed Host is rejected", () => {
  for (const host of ["evil.example", "evil.example:3000", "127.0.0.1.evil.example", "localhost.evil.example", "192.168.1.5:3000", "0.0.0.0:3000", "localhost:99999999", "local host"]) {
    assert.equal(isLoopbackRequest(new Headers({ host })), false, JSON.stringify(host));
  }
  assert.equal(isLoopbackRequest(new Headers()), false);
});

test("AC-HM-01: an Origin, when present, must itself be loopback; no Origin (non-browser client) is fine", () => {
  const host = "127.0.0.1:3000";
  assert.equal(isLoopbackRequest(new Headers({ host })), true);
  assert.equal(isLoopbackRequest(new Headers({ host, origin: "http://localhost:3000" })), true);
  assert.equal(isLoopbackRequest(new Headers({ host, origin: "http://127.0.0.1:3000" })), true);
  assert.equal(isLoopbackRequest(new Headers({ host, origin: "http://[::1]:3000" })), true);
  for (const origin of ["https://evil.example", "http://localhost.evil.example", "null", "not a url", "file:///x", "http://192.168.0.2"]) {
    assert.equal(isLoopbackRequest(new Headers({ host, origin })), false, origin);
  }
});

test("AC-HM-01: a non-loopback request is rejected with 403 BEFORE the token or toggle is consulted", async () => {
  const { endpoint, state } = setup({ enabled: false });
  const response = await endpoint.handle(rpc(LIST_TOOLS, { host: "evil.example", ...withToken("token-a") }));
  assert.equal(response.status, 403);
  assert.equal((await errorOf(response)).code, "AGENT_ENDPOINT_NOT_LOOPBACK");
  const rebinding = await endpoint.handle(rpc(LIST_TOOLS, { origin: "https://evil.example", ...withToken("token-a") }));
  assert.equal(rebinding.status, 403);
  assert.equal(state.createdServers, 0);
});

// ---- AC-HM-02: toggle -----------------------------------------------------------------------

test("AC-HM-02: toggle off -> 403 naming the setting, for a valid token too; applies on the very next request", async () => {
  const { endpoint, state } = setup({ enabled: false });
  const off = await endpoint.handle(rpc(LIST_TOOLS, withToken("token-a")));
  assert.equal(off.status, 403);
  const error = await errorOf(off);
  assert.equal(error.code, "MCP_CONNECTION_DISABLED");
  assert.match(error.message, /Settings/);
  assert.equal(state.createdServers, 0);

  state.enabled = true;
  assert.equal((await endpoint.handle(rpc(LIST_TOOLS, withToken("token-a")))).status, 200);
  state.enabled = false;
  assert.equal((await endpoint.handle(rpc(LIST_TOOLS, withToken("token-a")))).status, 403);
});

// ---- AC-HM-03: token errors -----------------------------------------------------------------

test("AC-HM-03: missing / non-Bearer / empty / unknown token -> 401 with an explicit message, no WWW-Authenticate", async () => {
  const { endpoint, state } = setup();
  const cases: Array<[Record<string, string>, string]> = [
    [{}, "AGENT_TOKEN_REQUIRED"],
    [{ authorization: "Basic dXNlcjpwYXNz" }, "AGENT_TOKEN_REQUIRED"],
    [{ authorization: "Bearer" }, "AGENT_TOKEN_REQUIRED"],
    [{ authorization: "Bearer " }, "AGENT_TOKEN_REQUIRED"],
    [{ authorization: "token-a" }, "AGENT_TOKEN_REQUIRED"],
    [withToken("nope"), "AGENT_TOKEN_INVALID"],
  ];
  for (const [headers, code] of cases) {
    const response = await endpoint.handle(rpc(LIST_TOOLS, headers));
    assert.equal(response.status, 401, JSON.stringify(headers));
    assert.equal(response.headers.get("www-authenticate"), null);
    const error = await errorOf(response);
    assert.equal(error.code, code, JSON.stringify(headers));
    assert.ok(error.message.length > 20);
    assert.equal(JSON.stringify(error).includes("nope"), false, "the presented token is never echoed");
  }
  assert.equal(state.createdServers, 0);
});

// ---- AC-HM-04: tool list --------------------------------------------------------------------

test("AC-HM-04: a valid token lists exactly the bound tools; no operator-only tool appears", async () => {
  const { endpoint } = setup();
  const response = await endpoint.handle(rpc(LIST_TOOLS, withToken("token-a")));
  assert.equal(response.status, 200);
  const body = await response.json();
  const names: string[] = body.result.tools.map((tool: { name: string }) => tool.name).sort();
  const expected = Object.entries(MCP_TOOL_CLASSIFICATION)
    .filter(([, toolClass]) => toolClass === "bound")
    .map(([name]) => name)
    .sort();
  assert.ok(expected.length > 40);
  assert.deepEqual(names, expected);
  for (const [name, toolClass] of Object.entries(MCP_TOOL_CLASSIFICATION)) {
    if (toolClass === "operator-only") assert.equal(names.includes(name), false, name);
  }
});

// ---- AC-HM-05: revocation ---------------------------------------------------------------------

test("AC-HM-05: revoking the token makes the very next request 401", async () => {
  const { endpoint, tokens } = setup();
  assert.equal((await endpoint.handle(rpc(LIST_TOOLS, withToken("token-a")))).status, 200);
  tokens.delete("token-a");
  const after = await endpoint.handle(rpc(LIST_TOOLS, withToken("token-a")));
  assert.equal(after.status, 401);
  assert.equal((await errorOf(after)).code, "AGENT_TOKEN_INVALID");
  // Another channel's token is unaffected.
  assert.equal((await endpoint.handle(rpc(LIST_TOOLS, withToken("token-b")))).status, 200);
});

// ---- AC-HM-06 / 07: scope through the real endpoint ---------------------------------------------

test("AC-HM-06: a call naming ANOTHER channel's id through the real endpoint is refused and returns no data", async () => {
  const { endpoint } = setup();
  const response = await endpoint.handle(
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list", arguments: { channelId: "UC_B" } } }, withToken("token-a"))
  );
  const body = await response.json();
  assert.equal(body.result.isError, true);
  const text = body.result.content[0].text as string;
  assert.equal(JSON.parse(text).error.code, "CHANNEL_NOT_ACTIVE");
});

test("AC-HM-07: interleaved requests for A, B and an operator path each run in their own scope", async () => {
  const seen: Array<[string, string | null]> = [];
  const gate = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const endpoint = createAgentMcpEndpoint({
    isConnectionEnabled: async () => true,
    verifyToken: async (token) => (token === "token-a" ? BINDING_A : BINDING_B),
    createServer: (options) => {
      const server = createMcpServer(undefined, options);
      // Probe tool: records the ambient scope before and after an await that lets other requests run.
      (server as unknown as { registerTool: (...args: unknown[]) => void }).registerTool(
        "scope_probe",
        { description: "test probe" },
        async () => {
          seen.push([options.agentSession.channelId, getAgentSession()?.channelId ?? null]);
          await gate(options.agentSession.channelId === "UC_A" ? 40 : 5);
          seen.push([options.agentSession.channelId, getAgentSession()?.channelId ?? null]);
          return { content: [{ type: "text" as const, text: "ok" }] };
        }
      );
      return server;
    },
  });
  const probe = (token: string) =>
    endpoint.handle(rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "scope_probe", arguments: {} } }, withToken(token)));

  const operatorSamples: Array<string | null> = [];
  await Promise.all([
    probe("token-a"),
    probe("token-b"),
    (async () => {
      await gate(10);
      operatorSamples.push(getAgentSession()?.channelId ?? null);
      await gate(60);
      operatorSamples.push(getAgentSession()?.channelId ?? null);
    })(),
  ]);

  // Every sample taken inside a request's handler saw exactly that request's own channel.
  assert.equal(seen.length, 4);
  for (const [expected, actual] of seen) assert.equal(actual, expected);
  assert.deepEqual(operatorSamples, [null, null]);
});

// ---- AC-HM-10: methods ----------------------------------------------------------------------------

test("AC-HM-10: only POST is served; GET, DELETE and PUT -> 405 with Allow: POST", async () => {
  const { endpoint } = setup();
  for (const method of ["GET", "DELETE", "PUT"]) {
    const response = await endpoint.handle(rpc(undefined, withToken("token-a"), method));
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal((await errorOf(response)).code, "AGENT_ENDPOINT_METHOD_NOT_ALLOWED");
  }
});

// ---- AC-HM-12 / 13: stdio and binding are gone ----------------------------------------------------

test("AC-HM-12: no stdio MCP transport, startMcpServer, mcp script or process-wide agent scope remains", async () => {
  const server = await readFile("src/mcp/server.ts", "utf8");
  assert.equal(/StdioServerTransport|startMcpServer|isMainModule/.test(server), false);
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal("mcp:video-metadata" in pkg.scripts, false);
  const session = await readFile("src/lib/agent-session/index.ts", "utf8");
  assert.equal(/export function enterAgentSession/.test(session), false);
  const cli = await readFile("src/cli/video-metadata.ts", "utf8");
  assert.equal(/enterAgentSession|createAgentTokenCore/.test(cli), false);
  assert.equal(/process\.env\.YTOM_AGENT_TOKEN/.test(cli), false);
});

test("AC-HM-13: the dev and start scripts bind the loopback interface only", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(pkg.scripts.dev, /-H 127\.0\.0\.1/);
  assert.match(pkg.scripts.start, /-H 127\.0\.0\.1/);
});
