import assert from "node:assert/strict";
import test from "node:test";
import { getAgentSession } from "@/lib/agent-session";
import { createFactoryTokenServices, type FactoryTokenStore } from "@/lib/factory-agent-tokens/services";
import { createAgentTokenServices } from "@/lib/agent-tokens/services";
import { DomainError } from "@/lib/shared-domain";
import { OperationLockError } from "@/lib/operation-lock";
import { RecoveryModeError } from "@/lib/device-mutation-gate";
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
    async findByHash(hash) {
      const row = rows.find((candidate) => candidate.tokenHash === hash);
      return row ? { ...row, revokedAt: row.revoked ? new Date("2026-10-05T12:00:00Z") : null } : null;
    },
    async listActive() {
      return rows.filter((row) => !row.revoked);
    },
  };
  return store;
}

function fakeToolDeps(overrides: Partial<FactoryToolDeps> = {}) {
  const outcomes: string[] = [];
  const mediaCalls: string[] = [];
  const gateClosed = { value: false };
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
    // BL-132: the media core is a fake that records what reached it.
    media: {
      storageStatus: async () => (mediaCalls.push("storageStatus"), { storage: { volumeId: "v" } }),
      listModels: async () => (mediaCalls.push("listModels"), { models: [] }),
      pullModel: async (input) => (mediaCalls.push(`pullModel:${JSON.stringify(input)}`), { pull: { pullId: "p1" } }),
      getPull: async (input) => (mediaCalls.push(`getPull:${input.pullId ?? ""}`), { pulls: [] }),
      cancelPull: async (input) => (mediaCalls.push(`cancelPull:${input.pullId}`), { pull: { pullId: input.pullId } }),
      deleteModel: async (input) => (mediaCalls.push(`deleteModel:${input.key}`), { deleted: input.key }),
      listTemplates: async () => (mediaCalls.push("listTemplates"), { templates: [] }),
      syncTemplates: async (input) => (mediaCalls.push(`syncTemplates:${input.dryRun}`), { result: { outcome: "ok" } }),
      startSession: async (input) => (mediaCalls.push(`startSession:${input.channelId}`), { session: { sessionId: "s1" }, approved: true, heldBy: null }),
      getSession: async (input) => (mediaCalls.push(`getSession:${input.sessionId ?? ""}`), { sessions: [] }),
      endSession: async (input) => (mediaCalls.push(`stopSession:${input.sessionId}`), { session: { sessionId: input.sessionId } }),
      createJob: async (input) => (mediaCalls.push(`createJob:${input.sessionId}`), { job: { jobId: "j1" } }),
      getJob: async (input) => (mediaCalls.push(`getJob:${input.jobId ?? ""}`), { job: { jobId: "j1" } }),
      cancelJob: async (input) => (mediaCalls.push(`cancelJob:${input.jobId}`), { job: { jobId: input.jobId } }),
      capacityLog: async () => (mediaCalls.push("capacityLog"), { attempts: [] }),
      deleteTemplate: async (input) => (mediaCalls.push(`deleteTemplate:${input.templateId}`), { deleted: true }),
      adoptTemplate: async (input) => (mediaCalls.push(`adoptTemplate:${input.templateId}>${input.newTemplateId}`), { status: "pending" }),
      getSettings: async () => (mediaCalls.push("getSettings"), { settings: {} }),
    },
    async assertMutationAllowed() {
      mediaCalls.push("gate");
      if (gateClosed.value) throw new DomainError({ code: "OPERATION_LOCKED" as never, message: "an import is running" });
    },
    ...overrides,
  };
  return { deps, outcomes, mediaCalls, gateClosed };
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

/** `setup` that also hands back the fake tool deps (BL-132 tests inspect what reached the media core). */
function setupWithDeps() {
  const tokenServices = createFactoryTokenServices({ store: createMemoryTokenStore(), generateSecret: () => "s1" });
  const toolDeps = fakeToolDeps();
  const endpoint = createFactoryMcpEndpoint({
    isConnectionEnabled: async () => true,
    verifyToken: (token) => tokenServices.verifyToken(token),
    createServer: ({ session }) => createFactoryMcpServer(toolDeps.deps, { connectionEnabled: true, session }),
  });
  return { endpoint, tokenServices, toolDeps };
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
      store: { async replace() {}, async revokeForChannel() { return 0; }, async findActiveByHash() { return null; }, async findByHash() { return null; }, async listActive() { return []; } },
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

// BL-132 (FACTORY_MEDIA_CONTROL_PLAN.md §2.6, ADR 0025, AC-FM-13) widened the closed list by eight media tools; BL-133
// (FACTORY_GPU_SESSIONS_PLAN.md §2.2/§2.5, ADR 0026, owner 2026-10-06) by seven more: the factory's own sessions, its jobs in
// them and the capacity log. No channel tool, and no tool that approves a session for anyone else, is added.
test("AC-FO-07 / AC-FM-13 / AC-FG-08: tools/list over the real endpoint is exactly the four 1.0.0 tools, the eight 1.1.0 media tools, the seven 1.2.0 tools and the three 1.3.0 tools (FO-REQ-0005)", async () => {
  const { endpoint, tokenServices } = setup();
  const { token } = await tokenServices.issueToken({});
  const body = await (await endpoint.handle(rpc(LIST_TOOLS, withToken(token)))).json();
  const names = (body.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "factory_get_capabilities",
    "factory_get_logical_path",
    "factory_list_channels",
    "factory_list_logical_paths",
    "factory_media_adopt_template",
    "factory_media_cancel_job",
    "factory_media_cancel_pull",
    "factory_media_capacity_log",
    "factory_media_create_job",
    "factory_media_delete_model",
    "factory_media_delete_template",
    "factory_media_get_job",
    "factory_media_get_pull",
    "factory_media_get_session",
    "factory_media_get_settings",
    "factory_media_list_models",
    "factory_media_list_templates",
    "factory_media_pull_model",
    "factory_media_start_session",
    "factory_media_stop_session",
    "factory_media_storage_status",
    "factory_media_sync_templates",
  ]);
  assert.equal(names.some((n) => /approve|reject/.test(n)), false, "no tool approves or rejects a session for anyone");
  assert.deepEqual([...FACTORY_TOOL_NAMES].sort(), names);
});

test("AC-FO-07: a channel tool name is not callable on the factory endpoint", async () => {
  const { endpoint, tokenServices } = setup();
  const { token } = await tokenServices.issueToken({});
  for (const name of ["agent_get_channel_context", "channel_list", "list", "apply", "agent_get_channel_workspace", "write_channel_select", "agent_get_logical_path"]) {
    const body = await (await endpoint.handle(rpc(call(name), withToken(token)))).json();
    // The MCP SDK's own answer for an unregistered tool: not a validation failure of a registered one.
    assert.equal(body.result?.isError, true, name);
    assert.match(String(body.result.content[0].text), /not found/i, name);
  }
});

// BL-132 (AC-FM-13): the capabilities answer now reports WRITE and names the write tools; version 1.1.0.
// BL-133: version 1.2.0 and the seven session/job/capacity tools (four of them writes).
// FO-REQ-0005: version 1.3.0, delete/adopt a local template (writes) and the settings read.
test("factory_get_capabilities reports the factory API version 1.3.0, READ and WRITE, the tool list and the write tools", async () => {
  const { endpoint, tokenServices } = setup();
  const { token } = await tokenServices.issueToken({});
  const result = await toolResult(await endpoint.handle(rpc(call("factory_get_capabilities"), withToken(token))));
  assert.equal(result.isError, false);
  assert.deepEqual(result.payload, {
    role: "factory_operator",
    factoryApiVersion: "1.3.0",
    tools: [
      "factory_get_capabilities",
      "factory_list_logical_paths",
      "factory_get_logical_path",
      "factory_list_channels",
      "factory_media_storage_status",
      "factory_media_list_models",
      "factory_media_pull_model",
      "factory_media_get_pull",
      "factory_media_cancel_pull",
      "factory_media_delete_model",
      "factory_media_list_templates",
      "factory_media_sync_templates",
      "factory_media_delete_template",
      "factory_media_adopt_template",
      "factory_media_get_settings",
      "factory_media_start_session",
      "factory_media_get_session",
      "factory_media_stop_session",
      "factory_media_create_job",
      "factory_media_get_job",
      "factory_media_cancel_job",
      "factory_media_capacity_log",
    ],
    permissions: ["READ", "WRITE"],
    writeTools: [
      "factory_media_pull_model",
      "factory_media_cancel_pull",
      "factory_media_delete_model",
      "factory_media_sync_templates",
      "factory_media_delete_template",
      "factory_media_adopt_template",
      "factory_media_start_session",
      "factory_media_stop_session",
      "factory_media_create_job",
      "factory_media_cancel_job",
    ],
  });
});

test("BL-132: every factory write passes the device mutation gate first and reaches nothing when it is closed; reads and a dry-run sync do not need it", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const SHA = "c".repeat(64);
  const writes: Array<[string, Record<string, unknown>, string]> = [
    ["factory_media_pull_model", { repoId: "a/b", file: "m.safetensors", folder: "checkpoints", sha256: SHA }, `pullModel:${JSON.stringify({ repoId: "a/b", file: "m.safetensors", folder: "checkpoints", sha256: SHA })}`],
    ["factory_media_cancel_pull", { pullId: "p1" }, "cancelPull:p1"],
    ["factory_media_delete_model", { key: "models/vae/x" }, "deleteModel:models/vae/x"],
    ["factory_media_sync_templates", {}, "syncTemplates:false"],
  ];
  for (const [name, args, reached] of writes) {
    toolDeps.mediaCalls.length = 0;
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, args), withToken(token))))).isError, false, name);
    assert.deepEqual(toolDeps.mediaCalls, ["gate", reached], name);
  }
  toolDeps.gateClosed.value = true;
  for (const [name, args] of writes) {
    toolDeps.mediaCalls.length = 0;
    const result = await toolResult(await endpoint.handle(rpc(call(name, args), withToken(token))));
    assert.equal(result.isError, true, name);
    assert.deepEqual(toolDeps.mediaCalls, ["gate"], `${name} reached nothing behind a closed gate`);
  }
  for (const [name, args, reached] of [
    ["factory_media_storage_status", {}, "storageStatus"],
    ["factory_media_list_models", {}, "listModels"],
    ["factory_media_get_pull", {}, "getPull:"],
    ["factory_media_list_templates", {}, "listTemplates"],
    ["factory_media_sync_templates", { dryRun: true }, "syncTemplates:true"],
  ] as const) {
    toolDeps.mediaCalls.length = 0;
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, { ...args }), withToken(token))))).isError, false, name);
    assert.deepEqual(toolDeps.mediaCalls, [reached], `${name} is not gated`);
  }
});

test("BL-132 (D2): a pull without sha256, or with a malformed one, is refused before the media core is reached", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  for (const args of [{ repoId: "a/b", file: "m", folder: "vae" }, { repoId: "a/b", file: "m", folder: "vae", sha256: "abc" }]) {
    toolDeps.mediaCalls.length = 0;
    // The SDK's own schema check answers first (plain text "MCP error ..."), so read the raw JSON-RPC body.
    const body = await (await endpoint.handle(rpc(call("factory_media_pull_model", args), withToken(token)))).json();
    assert.equal(body.result?.isError, true);
    assert.match(String(body.result.content[0].text), /sha256/);
    assert.deepEqual(toolDeps.mediaCalls, []);
  }
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
    const body = await (await endpoint.handle(rpc(call(name, { ...args }), withToken(token)))).json();
    // A registered tool rejecting an extra field, NOT an unknown tool and not a success.
    assert.equal(body.result?.isError, true, name);
    assert.doesNotMatch(String(body.result.content[0].text), /not found/i, name);
    assert.match(String(body.result.content[0].text), /invalid|unrecognized|validation/i, name);
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

test("AC-FO-08: the factory endpoint never enters the channel-bound agent scope, for any of its four tools", async () => {
  const seen: Record<string, unknown> = {};
  const { endpoint, tokenServices } = setup({
    toolDeps: {
      async listChannels() {
        seen.listChannels = getAgentSession();
        return [];
      },
      async listLogicalPaths() {
        seen.listLogicalPaths = getAgentSession();
        return [];
      },
      async readLogicalPath(input) {
        seen.readLogicalPath = getAgentSession();
        return { name: (input as { name: string }).name, path: "/x" };
      },
    },
  });
  const { token } = await tokenServices.issueToken({});
  for (const [name, args] of [
    ["factory_list_channels", {}],
    ["factory_list_logical_paths", {}],
    ["factory_get_logical_path", { name: "factory_shared" }],
    ["factory_get_capabilities", {}],
  ] as const) {
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, { ...args }), withToken(token))))).isError, false, name);
  }
  assert.deepEqual(seen, { listChannels: null, listLogicalPaths: null, readLogicalPath: null });
});

test("review round 2: a database failure while re-verifying a running session is not reported as a revoked token", async () => {
  const { deps, outcomes } = fakeToolDeps();
  const server = createFactoryMcpServer(deps, {
    connectionEnabled: true,
    session: {
      tokenId: "t",
      async reverify() {
        throw new Error("SQLITE_BUSY");
      },
    },
  });
  const endpoint = createFactoryMcpEndpoint({
    isConnectionEnabled: async () => true,
    verifyToken: async () => ({ tokenId: "t" }),
    createServer: () => server,
  });
  const result = await toolResult(await endpoint.handle(rpc(call("factory_list_logical_paths"), withToken("ytom_fo_x"))));
  assert.equal(result.isError, true);
  assert.equal((result.payload.error as { code: string }).code, "internal_error");
  assert.equal(JSON.stringify(result.payload).includes("SQLITE_BUSY"), false, "no driver detail leaks");
  assert.equal(JSON.stringify(result.payload).includes("factory_shared"), false, "no data on a blocked call");
  assert.deepEqual(outcomes, ["blocked"]);
});

test("with no valid session or with the connection disabled the server registers ZERO tools", async () => {
  for (const options of [{ session: null }, { session: { tokenId: "t", async reverify() {} }, connectionEnabled: false }]) {
    const server = createFactoryMcpServer(fakeToolDeps().deps, options);
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    assert.deepEqual(Object.keys(registered), []);
  }
});

test("BL-133 (AC-FG-08): the session and job writes pass the device mutation gate first and reach nothing when it is closed; the reads do not need it", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const writes: Array<[string, Record<string, unknown>, string]> = [
    ["factory_media_start_session", { channelId: "UC_A" }, "startSession:UC_A"],
    ["factory_media_stop_session", { sessionId: "s1" }, "stopSession:s1"],
    ["factory_media_create_job", { sessionId: "s1", templateId: "t1", params: { prompt: "x" } }, "createJob:s1"],
    ["factory_media_cancel_job", { jobId: "j1" }, "cancelJob:j1"],
  ];
  for (const [name, args, reached] of writes) {
    toolDeps.mediaCalls.length = 0;
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, args), withToken(token))))).isError, false, name);
    assert.deepEqual(toolDeps.mediaCalls, ["gate", reached], name);
  }
  toolDeps.gateClosed.value = true;
  for (const [name, args] of writes) {
    toolDeps.mediaCalls.length = 0;
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, args), withToken(token))))).isError, true, name);
    assert.deepEqual(toolDeps.mediaCalls, ["gate"], name);
  }
  for (const [name, args, reached] of [
    ["factory_media_get_session", {}, "getSession:"],
    ["factory_media_get_job", { jobId: "j1" }, "getJob:j1"],
    ["factory_media_capacity_log", {}, "capacityLog"],
  ] as const) {
    toolDeps.mediaCalls.length = 0;
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, { ...args }), withToken(token))))).isError, false, name);
    assert.deepEqual(toolDeps.mediaCalls, [reached], name);
  }
});

// FO-REQ-0005 item 2/4: the two local-template writes pass the device mutation gate first and reach nothing behind a closed
// one; the settings read does not need it.
test("FO-REQ-0005: delete/adopt template pass the device mutation gate first; get_settings is a read", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const writes: Array<[string, Record<string, unknown>, string]> = [
    ["factory_media_delete_template", { templateId: "local-1" }, "deleteTemplate:local-1"],
    ["factory_media_adopt_template", { templateId: "local-1", newTemplateId: "lofi-piano" }, "adoptTemplate:local-1>lofi-piano"],
  ];
  for (const [name, args, reached] of writes) {
    toolDeps.mediaCalls.length = 0;
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, args), withToken(token))))).isError, false, name);
    assert.deepEqual(toolDeps.mediaCalls, ["gate", reached], name);
  }
  toolDeps.gateClosed.value = true;
  for (const [name, args] of writes) {
    toolDeps.mediaCalls.length = 0;
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, args), withToken(token))))).isError, true, name);
    assert.deepEqual(toolDeps.mediaCalls, ["gate"], name);
  }
  toolDeps.mediaCalls.length = 0;
  const settings = await toolResult(await endpoint.handle(rpc(call("factory_media_get_settings", {}), withToken(token))));
  assert.equal(settings.isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ["getSettings"]);
});

// FO-REQ-0005 item 1: the device mutation gate throws OperationLockError / RecoveryModeError (not DomainErrors; their
// codes are documented in docs/interfaces.md). The role must get that code, never `internal_error`; anything else unknown
// stays `internal_error` with no internal detail echoed.
test("FO-REQ-0005: a write refused by the operation lock or recovery mode reports that code, not internal_error", async () => {
  for (const [thrown, expected] of [
    [new OperationLockError({ heldBy: { id: "singleton", operationType: "export", holderPid: 1, acquiredAt: "2026-10-07T00:00:00.000Z" }, stale: false }), "operation_lock_held"],
    [new RecoveryModeError([{ batchId: "b", ledgerRowId: "r", videoId: "v", status: "UNKNOWN" }]), "device_in_recovery_mode"],
    [Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" }), "internal_error"],
    [new Error("boom"), "internal_error"],
  ] as const) {
    const { endpoint, tokenServices } = setup({
      toolDeps: {
        async assertMutationAllowed() {
          throw thrown;
        },
      },
    });
    const { token } = await tokenServices.issueToken({});
    const originalError = console.error;
    console.error = () => undefined;
    let result;
    try {
      result = await toolResult(await endpoint.handle(rpc(call("factory_media_delete_model", { key: "models/checkpoints/a.safetensors" }), withToken(token))));
    } finally {
      console.error = originalError;
    }
    assert.equal(result.isError, true);
    const error = (result.payload as { error: { code: string; message: string } }).error;
    // Exactly what the device mutation gate threw -- the same shape the channel server reports for these two.
    assert.equal(error.code, expected, thrown.message);
    if (expected === "internal_error") assert.equal(error.message, "internal error", "no internal detail is echoed");
    else assert.equal(error.message, thrown.message);
  }
});
