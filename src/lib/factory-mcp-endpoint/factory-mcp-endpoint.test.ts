import assert from "node:assert/strict";
import test from "node:test";
import { getAgentSession } from "@/lib/agent-session";
import { createFactoryTokenServices, type FactoryTokenStore } from "@/lib/factory-agent-tokens/services";
import { createAgentTokenServices } from "@/lib/agent-tokens/services";
import { DomainError } from "@/lib/shared-domain";
import { createFactoryMcpServer, FACTORY_TOOL_NAMES, type FactoryToolDeps } from "@/mcp/factory-server";
import { createFactoryMcpEndpoint } from "./index";

// Expected behavior comes from docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md §2.1 and §4
// (AC-FO-06, AC-FO-07, AC-FO-08, AC-FO-13), written before this module.

function createMemoryTokenStore() {
  const rows: Array<{ id: string; tokenHash: string; label: string | null; createdAt: Date; revoked: boolean }> = [];
  const store: FactoryTokenStore = {
    async replace(input) {
      for (const row of rows) row.revoked = true;
      rows.push({ ...input, createdAt: new Date(), revoked: false });
    },
    async revoke() {
      let n = 0;
      for (const row of rows) if (!row.revoked) { row.revoked = true; n++; }
      return n;
    },
    async findActiveByHash(hash) {
      return rows.find((row) => row.tokenHash === hash && !row.revoked) ?? null;
    },
    async listActive() {
      return rows.filter((row) => !row.revoked);
    },
  };
  return store;
}

function fakeToolDeps(overrides: Partial<FactoryToolDeps> = {}) {
  const outcomes: string[] = [];
  const deps: FactoryToolDeps = {
    async readLogicalPath(input) {
      const name = (input as { name: string }).name;
      if (name === "factory_shared") return { name, path: "C:\\Factory\\02 Shared Registry" };
      if (name === "unset_one") {
        throw new DomainError({ code: "LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE", message: "no value on this device", details: { name } });
      }
      throw new DomainError({ code: "LOGICAL_PATH_NOT_FOUND", message: "no logical path with this name is available", details: { name } });
    },
    async listLogicalPaths() {
      return [
        { name: "factory_shared", description: "", configured: true as const, path: "C:\\Factory\\02 Shared Registry" },
        { name: "unset_one", description: "", configured: false as const },
      ];
    },
    async listChannels() {
      return [
        { channelId: "UC_A", title: "Channel A", workspace: { configured: true as const, path: "C:\\Work\\A" } },
        { channelId: "UC_B", title: "Channel B", workspace: { configured: false as const } },
      ];
    },
    async recordOutcome(outcome) {
      outcomes.push(outcome);
    },
    ...overrides,
  };
  return { deps, outcomes };
}

function setup(initial: { enabled?: boolean; toolDeps?: Partial<FactoryToolDeps> } = {}) {
  const tokenServices = createFactoryTokenServices({ store: createMemoryTokenStore(), generateSecret: () => "s1" });
  const state = { enabled: initial.enabled ?? true, createdServers: 0 };
  const { deps, outcomes } = fakeToolDeps(initial.toolDeps);
  const endpoint = createFactoryMcpEndpoint({
    isConnectionEnabled: async () => state.enabled,
    verifyToken: (token) => tokenServices.verifyToken(token),
    createServer: ({ session }) => {
      state.createdServers++;
      return createFactoryMcpServer(deps, { connectionEnabled: true, session });
    },
  });
  return { endpoint, tokenServices, state, outcomes };
}

function rpc(body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("http://127.0.0.1:3000/api/mcp/factory", {
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
const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
const withToken = (token: string) => ({ authorization: `Bearer ${token}` });
const errorOf = async (response: Response): Promise<{ code: string; message: string }> => (await response.json()).error;

async function toolResult(response: Response) {
  const body = await response.json();
  return { isError: Boolean(body.result.isError), payload: JSON.parse(body.result.content[0].text) as Record<string, unknown> };
}

test("AC-FO-06: a non-loopback request is rejected with 403 before the toggle or token is consulted", async () => {
  const { endpoint, state } = setup({ enabled: false });
  const response = await endpoint.handle(rpc(LIST_TOOLS, { host: "evil.example", ...withToken("ytom_fo_s1") }));
  assert.equal(response.status, 403);
  assert.equal((await errorOf(response)).code, "AGENT_ENDPOINT_NOT_LOOPBACK");
  assert.equal(state.createdServers, 0);
});

test("AC-FO-06: only POST is served (GET/DELETE/PUT -> 405 with Allow: POST)", async () => {
  const { endpoint } = setup();
  for (const method of ["GET", "DELETE", "PUT"]) {
    const response = await endpoint.handle(rpc(LIST_TOOLS, {}, method));
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "POST");
  }
});

test("AC-FO-06: toggle off -> 403 for a valid token too; takes effect on the very next request", async () => {
  const { endpoint, tokenServices, state } = setup({ enabled: false });
  const { token } = await tokenServices.issueToken({});
  const off = await endpoint.handle(rpc(LIST_TOOLS, withToken(token)));
  assert.equal(off.status, 403);
  assert.equal((await errorOf(off)).code, "MCP_CONNECTION_DISABLED");
  assert.equal(state.createdServers, 0);

  state.enabled = true;
  assert.equal((await endpoint.handle(rpc(LIST_TOOLS, withToken(token)))).status, 200);
  state.enabled = false;
  assert.equal((await endpoint.handle(rpc(LIST_TOOLS, withToken(token)))).status, 403);
});

test("AC-FO-06: missing token -> 401 AGENT_TOKEN_REQUIRED; unknown, channel-type and revoked tokens -> 401 AGENT_TOKEN_INVALID", async () => {
  const { endpoint, tokenServices, state } = setup();
  const missing = await endpoint.handle(rpc(LIST_TOOLS));
  assert.equal(missing.status, 401);
  assert.equal((await errorOf(missing)).code, "AGENT_TOKEN_REQUIRED");

  const issued = await tokenServices.issueToken({});
  const channelToken = (
    await createAgentTokenServices({
      store: { async replace() {}, async revokeForChannel() { return 0; }, async findActiveByHash() { return null; }, async listActive() { return []; } },
      getChannelConnectedUserId: async () => "u-a",
      getLiveChannelIdForUser: async () => "UC_A",
      generateSecret: () => "ch1",
    }).issueToken({ channelId: "UC_A" })
  ).token;
  assert.equal(channelToken.startsWith("ytom_ch_"), true);

  for (const token of ["nope", "ytom_fo_unknown", channelToken]) {
    const response = await endpoint.handle(rpc(LIST_TOOLS, withToken(token)));
    assert.equal(response.status, 401, token);
    const error = await errorOf(response);
    assert.equal(error.code, "AGENT_TOKEN_INVALID");
    assert.equal(JSON.stringify(error).includes(token), false, "the presented token is never echoed");
  }
  assert.equal(state.createdServers, 0);

  await tokenServices.revokeToken();
  assert.equal((await endpoint.handle(rpc(LIST_TOOLS, withToken(issued.token)))).status, 401);
});

test("a non-token verification failure (database down) is a 503, never a false 'token revoked' 401", async () => {
  const endpoint = createFactoryMcpEndpoint({
    isConnectionEnabled: async () => true,
    verifyToken: async () => {
      throw new Error("SQLITE_BUSY");
    },
    createServer: () => {
      throw new Error("must not be called");
    },
  });
  const response = await endpoint.handle(rpc(LIST_TOOLS, withToken("ytom_fo_x")));
  assert.equal(response.status, 503);
  assert.equal((await errorOf(response)).code, "AGENT_ENDPOINT_UNAVAILABLE");
});

test("AC-FO-07: tools/list over the real endpoint is exactly the four factory tools", async () => {
  const { endpoint, tokenServices } = setup();
  const { token } = await tokenServices.issueToken({});
  const body = await (await endpoint.handle(rpc(LIST_TOOLS, withToken(token)))).json();
  const names = (body.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "factory_get_capabilities",
    "factory_get_logical_path",
    "factory_list_channels",
    "factory_list_logical_paths",
  ]);
  assert.deepEqual([...FACTORY_TOOL_NAMES].sort(), names);
});

test("AC-FO-07: a channel tool name is not callable on the factory endpoint", async () => {
  const { endpoint, tokenServices } = setup();
  const { token } = await tokenServices.issueToken({});
  for (const name of ["agent_get_channel_context", "channel_list", "list", "apply", "agent_get_channel_workspace", "write_channel_select"]) {
    const result = await toolResultOrRpcError(await endpoint.handle(rpc(call(name), withToken(token))));
    assert.equal(result.failed, true, name);
  }
});

async function toolResultOrRpcError(response: Response) {
  const body = await response.json();
  return { failed: Boolean(body.error) || Boolean(body.result?.isError) };
}

test("factory_get_capabilities reports the factory API version 1.0.0, READ only, and the tool list", async () => {
  const { endpoint, tokenServices } = setup();
  const { token } = await tokenServices.issueToken({});
  const result = await toolResult(await endpoint.handle(rpc(call("factory_get_capabilities"), withToken(token))));
  assert.equal(result.isError, false);
  assert.deepEqual(result.payload, {
    role: "factory_operator",
    factoryApiVersion: "1.0.0",
    tools: ["factory_get_capabilities", "factory_list_logical_paths", "factory_get_logical_path", "factory_list_channels"],
    permissions: ["READ"],
  });
});

test("AC-FO-02: the logical path tools return the value, or an explicit error for an unset / unknown name", async () => {
  const { endpoint, tokenServices } = setup();
  const { token } = await tokenServices.issueToken({});

  const ok = await toolResult(await endpoint.handle(rpc(call("factory_get_logical_path", { name: "factory_shared" }), withToken(token))));
  assert.deepEqual(ok.payload, { name: "factory_shared", path: "C:\\Factory\\02 Shared Registry" });

  const unset = await toolResult(await endpoint.handle(rpc(call("factory_get_logical_path", { name: "unset_one" }), withToken(token))));
  assert.equal(unset.isError, true);
  assert.equal((unset.payload.error as { code: string }).code, "LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE");
  assert.equal(JSON.stringify(unset.payload).includes('"path"'), false);

  const unknown = await toolResult(await endpoint.handle(rpc(call("factory_get_logical_path", { name: "no_such" }), withToken(token))));
  assert.equal((unknown.payload.error as { code: string }).code, "LOGICAL_PATH_NOT_FOUND");

  const listed = await toolResult(await endpoint.handle(rpc(call("factory_list_logical_paths"), withToken(token))));
  assert.deepEqual(listed.payload.paths, [
    { name: "factory_shared", description: "", configured: true, path: "C:\\Factory\\02 Shared Registry" },
    { name: "unset_one", description: "", configured: false },
  ]);
});

test("AC-FO-09: tool inputs are strict -- an extra field (e.g. a path to set) is rejected", async () => {
  const { endpoint, tokenServices } = setup();
  const { token } = await tokenServices.issueToken({});
  for (const [name, args] of [
    ["factory_get_logical_path", { name: "factory_shared", path: "/etc" }],
    ["factory_list_logical_paths", { path: "/etc" }],
    ["factory_list_channels", { channelId: "UC_A" }],
    ["factory_get_capabilities", { x: 1 }],
  ] as const) {
    const result = await toolResultOrRpcError(await endpoint.handle(rpc(call(name, { ...args }), withToken(token))));
    assert.equal(result.failed, true, name);
  }
});

test("AC-FO-08: factory_list_channels returns exactly the allowed keys per channel", async () => {
  const { endpoint, tokenServices } = setup();
  const { token } = await tokenServices.issueToken({});
  const result = await toolResult(await endpoint.handle(rpc(call("factory_list_channels"), withToken(token))));
  const channels = result.payload.channels as Array<Record<string, unknown>>;
  assert.equal(channels.length, 2);
  for (const channel of channels) assert.deepEqual(Object.keys(channel).sort(), ["channelId", "title", "workspace"]);
  assert.deepEqual(channels[0].workspace, { configured: true, path: "C:\\Work\\A" });
  assert.deepEqual(channels[1].workspace, { configured: false });
});

test("AC-FO-06: revoking the token makes the very next call of a running session fail, with no data", async () => {
  const { endpoint, tokenServices, outcomes } = setup();
  const { token } = await tokenServices.issueToken({});
  const first = await toolResult(await endpoint.handle(rpc(call("factory_list_logical_paths"), withToken(token))));
  assert.equal(first.isError, false);

  // A session verified before the revocation, whose per-call re-verification then fails.
  let revoked = false;
  const raceEndpoint = createFactoryMcpEndpoint({
    isConnectionEnabled: async () => true,
    verifyToken: async (presented) => {
      if (revoked) throw new DomainError({ code: "AGENT_TOKEN_INVALID", message: "revoked" });
      return tokenServices.verifyToken(presented);
    },
    createServer: ({ session }) => {
      const server = createFactoryMcpServer(fakeToolDeps().deps, { connectionEnabled: true, session });
      revoked = true; // revoked between the endpoint's check and the tool call
      return server;
    },
  });
  const blocked = await toolResult(await raceEndpoint.handle(rpc(call("factory_list_logical_paths"), withToken(token))));
  assert.equal(blocked.isError, true);
  assert.equal((blocked.payload.error as { code: string }).code, "AGENT_TOKEN_INVALID");
  assert.equal(JSON.stringify(blocked.payload).includes("factory_shared"), false, "no data on a blocked call");
  assert.deepEqual(outcomes, ["allowed"]);
});

test("AC-FO-08: the factory endpoint never enters the channel-bound agent scope", async () => {
  let scopeSeen: unknown = "unset";
  const { endpoint, tokenServices } = setup({
    toolDeps: {
      async listChannels() {
        scopeSeen = getAgentSession();
        return [];
      },
    },
  });
  const { token } = await tokenServices.issueToken({});
  await endpoint.handle(rpc(call("factory_list_channels"), withToken(token)));
  assert.equal(scopeSeen, null);
});

test("with no valid session or with the connection disabled the server registers ZERO tools", async () => {
  for (const options of [{ session: null }, { session: { tokenId: "t", async reverify() {} }, connectionEnabled: false }]) {
    const server = createFactoryMcpServer(fakeToolDeps().deps, options);
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    assert.deepEqual(Object.keys(registered), []);
  }
});
