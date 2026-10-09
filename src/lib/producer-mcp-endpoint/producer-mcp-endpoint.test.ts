import assert from "node:assert/strict";
import test from "node:test";
import { listAgentCapabilityDescriptors } from "@/lib/agent-operations/services";
import { createProducerTokenServices } from "@/lib/producer-agent-tokens/services";
import type { RoleTokenStore } from "@/lib/role-agent-tokens";
import { addChannelRecordAssignment, insertResearchChannel, upsertChannel, upsertVideos } from "@/lib/db";
import { createAgentTokenServices } from "@/lib/agent-tokens/services";
import { DomainError } from "@/lib/shared-domain";
import { createMcpServer, type ProducerSession } from "@/mcp/server";
import { PRODUCER_API_VERSION, PRODUCER_CHANNEL_TOOLS, PRODUCER_TOOL_NAMES } from "@/mcp/producer-tools";
import { MCP_TOOL_CLASSIFICATION } from "@/mcp/tool-classification";
import { createProducerMcpEndpoint, type ProducerRefusedCall } from "./index";

// Expected behavior from docs/roadmap/plans/PRODUCER_ROLE_PLAN.md §3 (AC-PR-02..07, 09, 10), written before this endpoint, from
// FO-REQ-0012 §2/§4: a producer token reads any channel connected on this device, one channel per call, through exactly the checks
// that channel's own agent goes through; nothing else is reachable. The server below is the real one (real channel tool handlers
// on this test process's isolated database), only the producer's session deps are fakes.

function memoryTokenStore(): RoleTokenStore {
  const rows: Array<{ id: string; tokenHash: string; label: string | null; createdAt: Date; revoked: boolean }> = [];
  return {
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
      return row ? { ...row, revokedAt: row.revoked ? new Date() : null } : null;
    },
    async listActive() {
      return rows.filter((row) => !row.revoked);
    },
  };
}

const CONNECTED: Record<string, string> = { UC_PR_X: "user-pr-x", UC_PR_Y: "user-pr-y" };

async function seedTwoChannels() {
  for (const [channelId, userId] of Object.entries(CONNECTED)) {
    await upsertChannel({ channelId, title: `Channel ${channelId}`, thumbnailUrl: null, uploadsPlaylistId: `UU${channelId}`, connectedUserId: userId });
  }
  const video = (videoId: string, channelId: string) => ({
    videoId,
    channelId,
    title: `Title ${videoId}`,
    description: "",
    publishedAt: "2026-10-01T10:00:00Z",
    privacyStatus: "public",
    defaultLanguage: null,
    defaultAudioLanguage: null,
    thumbnails: {},
    existingLocalizations: {},
    etag: null,
  });
  await upsertVideos([video("vid-x-1", "UC_PR_X"), video("vid-x-2", "UC_PR_X"), video("vid-y-1", "UC_PR_Y")], new Date("2026-10-09T10:00:00Z"));
}

function setup(initial: { enabled?: boolean } = {}) {
  let n = 0;
  const tokens = createProducerTokenServices({ store: memoryTokenStore(), generateSecret: () => String(++n).padStart(43, "s") });
  const state = { enabled: initial.enabled ?? true, createdServers: 0 };
  const calls: Array<{ tool: string; channelId: string | null; outcome: string; errorCode: string | null }> = [];
  const refused: ProducerRefusedCall[] = [];
  const endpoint = createProducerMcpEndpoint({
    isConnectionEnabled: async () => state.enabled,
    verifyToken: (token) => tokens.verifyToken(token),
    isProducerTool: (name) => PRODUCER_TOOL_NAMES.includes(name),
    recordRefusedCall: async (call) => {
      refused.push(call);
    },
    createServer: ({ session }) => {
      state.createdServers++;
      const producerSession: ProducerSession = {
        tokenId: session.tokenId,
        reverify: () => session.reverify(),
        resolveChannelUser: async (channelId) => CONNECTED[channelId] ?? null,
        recordCall: async (entry) => {
          session.noteRecorded(entry.tool, entry.channelId);
          calls.push(entry);
        },
        listChannels: async () => [
          { channelId: "UC_PR_X", title: "Channel UC_PR_X", workspace: "/Volumes/T9/X" },
          { channelId: "UC_PR_Y", title: "Channel UC_PR_Y", workspace: null },
        ],
        portfolioOverview: async (input) => ({ ...input, source: "local", channels: [] }),
      };
      return createMcpServer(undefined, { connectionEnabled: true, producerSession });
    },
  });
  return { endpoint, tokens, state, calls, refused };
}

function rpc(body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("http://127.0.0.1:3000/api/mcp/producer", {
    method,
    headers: { host: "127.0.0.1:3000", "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

const LIST_TOOLS = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function toolResult(response: Response) {
  const body = await response.json();
  return { isError: Boolean(body.result.isError), text: body.result.content[0].text as string };
}
const payloadOf = (text: string) => JSON.parse(text) as Record<string, unknown>;

test("AC-PR-02: loopback, POST only, the MCP switch, and a Bearer producer token -- each refused before any server is built", async () => {
  const { endpoint, tokens, state } = setup({ enabled: false });
  const token = (await tokens.issueToken({})).token;
  assert.equal((await endpoint.handle(rpc(LIST_TOOLS, { host: "evil.example", ...bearer(token) }))).status, 403);
  assert.equal((await endpoint.handle(rpc(LIST_TOOLS, bearer(token), "GET"))).status, 405);
  assert.equal((await endpoint.handle(rpc(LIST_TOOLS, bearer(token)))).status, 403); // switch off
  state.enabled = true;
  assert.equal((await endpoint.handle(rpc(LIST_TOOLS))).status, 401);
  for (const other of [`ytom_fo_${"s".repeat(43)}`, `ytom_ch_UC_PR_X.${"s".repeat(43)}`]) {
    const refused = await endpoint.handle(rpc(LIST_TOOLS, bearer(other)));
    assert.equal(refused.status, 401);
    assert.equal((await refused.json()).error.code, "AGENT_TOKEN_INVALID");
  }
  assert.equal(state.createdServers, 0);
});

test("AC-PR-03: tools/list is exactly the closed list, and every channel tool in it is a READ capability", async () => {
  const { endpoint, tokens } = setup();
  const token = (await tokens.issueToken({})).token;
  const listed = ((await (await endpoint.handle(rpc(LIST_TOOLS, bearer(token)))).json()).result.tools as Array<{ name: string; inputSchema: { required?: string[] } }>);
  assert.deepEqual(listed.map((tool) => tool.name).sort(), [...PRODUCER_TOOL_NAMES].sort());
  for (const tool of listed) {
    if (tool.name.startsWith("producer_")) continue;
    assert.ok(tool.inputSchema.required?.includes("channelId"), `${tool.name} must require channelId`);
  }
  const capabilities = new Map(listAgentCapabilityDescriptors().map((capability) => [capability.id, capability]));
  // These three READ capabilities predate the registry's `mcpTools` field; each is pinned to its one tool here, so no other tool
  // (a DRAFT or WRITE one, say) can be mapped onto a capability that lists no tools (review round 1).
  const PINNED_WITHOUT_MCP_TOOLS: Record<string, string> = {
    channel_video_list: "video_context.list_videos",
    query_competitors: "market_intelligence.query_competitors",
    query_market_intelligence: "market_intelligence.query_market_intelligence",
  };
  for (const [tool, { capability }] of Object.entries(PRODUCER_CHANNEL_TOOLS)) {
    const descriptor = capabilities.get(capability);
    assert.ok(descriptor, `${tool}: capability ${capability} exists`);
    assert.equal(descriptor.permission, "READ", `${tool} must be a READ capability`);
    if (descriptor.mcpTools) assert.ok(descriptor.mcpTools.includes(tool), `${capability} names ${tool}`);
    else assert.equal(PINNED_WITHOUT_MCP_TOOLS[tool], capability, `${tool} maps to a capability that names no tool`);
    assert.equal(MCP_TOOL_CLASSIFICATION[tool], "bound");
  }
});

test("AC-PR-03: a channel agent's session never lists a producer tool", () => {
  const server = createMcpServer(undefined, { connectionEnabled: true, agentSession: { tokenId: "t", channelId: "UC_PR_X", async reverify() {} } });
  const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  assert.equal(names.some((name) => name.startsWith("producer_")), false);
  assert.throws(() => createMcpServer(undefined, { connectionEnabled: true, agentSession: { tokenId: "t", channelId: "UC_PR_X", async reverify() {} }, producerSession: {} as ProducerSession }));
});

test("AC-PR-04: a channel call without channelId is refused at input; a channel not connected here is refused and logged", async () => {
  const { endpoint, tokens, calls, refused } = setup();
  const token = (await tokens.issueToken({})).token;
  const missing = await toolResult(await endpoint.handle(rpc(call("channel_video_list", {}), bearer(token))));
  assert.equal(missing.isError, true);
  assert.deepEqual(refused, [{ tool: "channel_video_list", channelId: null, errorCode: "INVALID_PARAMS" }]);
  const unknown = await toolResult(await endpoint.handle(rpc(call("channel_video_list", { channelId: "UC_PR_ELSEWHERE" }), bearer(token))));
  assert.equal(unknown.isError, true);
  assert.equal((payloadOf(unknown.text).error as { code: string }).code, "CHANNEL_NOT_ACTIVE");
  assert.equal(payloadOf(unknown.text).forChannelId, "UC_PR_ELSEWHERE");
  assert.deepEqual(calls.at(-1), { tool: "channel_video_list", channelId: "UC_PR_ELSEWHERE", outcome: "error", errorCode: "CHANNEL_NOT_ACTIVE" });
});

test("AC-PR-05 / AC-PR-06 / AC-PR-09: each call reads only its own channel's rows, names that channel, and is logged", async () => {
  await seedTwoChannels();
  const { endpoint, tokens, calls } = setup();
  const token = (await tokens.issueToken({})).token;
  const videoIds = async (channelId: string) => {
    const result = await toolResult(await endpoint.handle(rpc(call("channel_video_list", { channelId }), bearer(token))));
    assert.equal(result.isError, false, result.text);
    const payload = payloadOf(result.text);
    assert.equal(payload.forChannelId, channelId);
    return ((payload.videos as Array<{ videoId: string }>) ?? []).map((video) => video.videoId).sort();
  };
  assert.deepEqual(await videoIds("UC_PR_X"), ["vid-x-1", "vid-x-2"]);
  assert.deepEqual(await videoIds("UC_PR_Y"), ["vid-y-1"]);
  const context = await toolResult(await endpoint.handle(rpc(call("agent_get_channel_context", { channelId: "UC_PR_Y" }), bearer(token))));
  assert.equal(context.isError, false, context.text);
  assert.equal(payloadOf(context.text).forChannelId, "UC_PR_Y");
  assert.match(context.text, /UC_PR_Y/);
  assert.doesNotMatch(context.text, /UC_PR_X/);
  assert.deepEqual(
    calls.map((entry) => [entry.tool, entry.channelId, entry.outcome]),
    [
      ["channel_video_list", "UC_PR_X", "ok"],
      ["channel_video_list", "UC_PR_Y", "ok"],
      ["agent_get_channel_context", "UC_PR_Y", "ok"],
    ]
  );
});

test("query_market_intelligence: `channelId` is the Producer's channel, the watchlist channel travels as watchlistChannelId", async () => {
  const { endpoint, tokens } = setup();
  const token = (await tokens.issueToken({})).token;
  const result = await toolResult(
    await endpoint.handle(rpc(call("query_market_intelligence", { channelId: "UC_PR_X", watchlistChannelId: "UC_COMPETITOR" }), bearer(token)))
  );
  // Nothing is assigned to UC_PR_X: the refusal names the WATCHLIST id, which proves the tool received that one as its own
  // channelId -- and that the Producer's market reads are narrowed to the named channel's assignments, as a channel agent's are.
  assert.equal(result.isError, true);
  const payload = payloadOf(result.text) as { error: { code: string; details?: { recordId?: string } }; forChannelId: string };
  assert.equal(payload.forChannelId, "UC_PR_X");
  assert.equal(payload.error.code, "RESEARCH_CHANNEL_NOT_AVAILABLE");
  assert.equal(payload.error.details?.recordId, "UC_COMPETITOR");
});

test("AC-PR-07 / AC-PR-10: the Producer's own tools -- its channels with their folders, and its capabilities", async () => {
  const { endpoint, tokens, calls } = setup();
  const token = (await tokens.issueToken({})).token;
  const channels = await toolResult(await endpoint.handle(rpc(call("producer_list_channels"), bearer(token))));
  assert.deepEqual(payloadOf(channels.text).channels, [
    { channelId: "UC_PR_X", title: "Channel UC_PR_X", workspace: "/Volumes/T9/X" },
    { channelId: "UC_PR_Y", title: "Channel UC_PR_Y", workspace: null },
  ]);
  const capabilities = payloadOf((await toolResult(await endpoint.handle(rpc(call("producer_get_capabilities"), bearer(token))))).text);
  assert.equal(capabilities.role, "producer");
  assert.equal(capabilities.producerApiVersion, PRODUCER_API_VERSION);
  assert.equal(PRODUCER_API_VERSION, "1.0.0");
  assert.deepEqual(capabilities.permissions, ["READ"]);
  assert.deepEqual([...(capabilities.tools as string[])].sort(), [...PRODUCER_TOOL_NAMES].sort());
  assert.deepEqual(calls.map((entry) => [entry.tool, entry.channelId]), [
    ["producer_list_channels", null],
    ["producer_get_capabilities", null],
  ]);
});

test("a token revoked mid-session is refused on its next call, before any channel is read", async () => {
  const { endpoint, tokens, calls } = setup();
  const token = (await tokens.issueToken({})).token;
  await tokens.revokeToken();
  const refused = await endpoint.handle(rpc(call("channel_video_list", { channelId: "UC_PR_X" }), bearer(token)));
  assert.equal(refused.status, 401);
  assert.deepEqual(calls, []);
  // Inside a running server: the per-call re-verification refuses and logs it.
  let revoked = false;
  const logged: string[] = [];
  const server = createMcpServer(undefined, {
    connectionEnabled: true,
    producerSession: {
      tokenId: "p1",
      async reverify() {
        if (revoked) throw new DomainError({ code: "AGENT_TOKEN_INVALID", message: "revoked" });
      },
      resolveChannelUser: async (channelId) => CONNECTED[channelId] ?? null,
      recordCall: async (entry) => {
        logged.push(`${entry.tool}:${entry.outcome}:${entry.errorCode}`);
      },
      listChannels: async () => [],
      portfolioOverview: async () => ({}),
    },
  });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean }> }> })._registeredTools;
  revoked = true;
  assert.equal((await tools.channel_video_list.handler({ channelId: "UC_PR_X" })).isError, true);
  assert.deepEqual(logged, ["channel_video_list:error:AGENT_TOKEN_INVALID"]);
});

// Review round 1: calls the MCP layer refuses before any tool runs were missing from the log (FO-REQ-0012 §2.4: every call).
test("AC-PR-09: an unknown tool, a refused input and a caller credentialRef are logged too; a good call is logged once", async () => {
  const { endpoint, tokens, calls, refused } = setup();
  const token = (await tokens.issueToken({})).token;
  assert.equal((await toolResult(await endpoint.handle(rpc(call("apply", { channelId: "UC_PR_X" }), bearer(token))))).isError, true);
  assert.equal(
    (await toolResult(await endpoint.handle(rpc(call("producer_portfolio_overview", { startDate: "2025-01-01", endDate: "2026-10-01" }), bearer(token))))).isError,
    true
  );
  assert.equal(
    (await toolResult(await endpoint.handle(rpc(call("channel_video_list", { channelId: "UC_PR_X", credentialRef: { userId: "user-pr-y" } }), bearer(token))))).isError,
    true
  );
  assert.deepEqual(refused, [
    { tool: "apply", channelId: "UC_PR_X", errorCode: "TOOL_NOT_FOUND" },
    { tool: "producer_portfolio_overview", channelId: null, errorCode: "INVALID_PARAMS" },
    { tool: "channel_video_list", channelId: "UC_PR_X", errorCode: "INVALID_PARAMS" },
  ]);
  assert.equal(calls.length, 0);
  // A batch: the good call is logged by the tool, only the refused one by the endpoint.
  const batch = [call("producer_list_channels"), { ...call("channel_video_list", {}), id: 3 }];
  const response = await endpoint.handle(rpc(batch, bearer(token)));
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((entry) => entry.tool), ["producer_list_channels"]);
  assert.deepEqual(refused.at(-1), { tool: "channel_video_list", channelId: null, errorCode: "INVALID_PARAMS" });
  assert.equal(refused.length, 4);
});

test("AC-PR-08 input: the portfolio range must be real calendar dates, start before end, at most 366 days", async () => {
  const { endpoint, tokens } = setup();
  const token = (await tokens.issueToken({})).token;
  const overview = (startDate: string, endDate: string) =>
    endpoint.handle(rpc(call("producer_portfolio_overview", { startDate, endDate }), bearer(token))).then(toolResult);
  assert.equal((await overview("2026-02-01", "2026-02-31")).isError, true);
  assert.equal((await overview("2026-13-01", "2026-12-31")).isError, true);
  assert.equal((await overview("2026-10-07", "2026-10-01")).isError, true);
  assert.equal((await overview("2026-01-01", "2027-01-01")).isError, false); // 365 days apart = 366 days inclusive
});

test("AC-PR-05: a market record assigned only to channel Y is not readable through channel X", async () => {
  await seedTwoChannels();
  await insertResearchChannel({ id: "UC_PR_COMP", reason: "competitor of Y", createdVia: "operator" });
  await addChannelRecordAssignment("UC_PR_Y", "research_channel", "UC_PR_COMP");
  const { endpoint, tokens } = setup();
  const token = (await tokens.issueToken({})).token;
  const read = (channelId: string) =>
    endpoint.handle(rpc(call("query_market_intelligence", { channelId, watchlistChannelId: "UC_PR_COMP" }), bearer(token))).then(toolResult);
  const viaX = await read("UC_PR_X");
  assert.equal(viaX.isError, true);
  assert.equal((payloadOf(viaX.text).error as { code: string }).code, "RESEARCH_CHANNEL_NOT_AVAILABLE");
  const viaY = await read("UC_PR_Y");
  assert.equal(viaY.isError, false, viaY.text);
  assert.equal(payloadOf(viaY.text).forChannelId, "UC_PR_Y");
});

test("AC-PR-02: a producer token is refused by the channel agents' verifier", async () => {
  const channelTokens = createAgentTokenServices({
    store: { async replace() {}, async revokeForChannel() { return 0; }, async findActiveByHash() { return null; }, async findByHash() { return null; }, async listActive() { return []; } },
    getChannelConnectedUserId: async () => "user-pr-x",
    getLiveChannelIdForUser: async () => "UC_PR_X",
  });
  await assert.rejects(channelTokens.verifyToken(`ytom_pr_${"s".repeat(43)}`), (error: unknown) => (error as { code?: string }).code === "AGENT_TOKEN_INVALID");
});

// Review round 2: a refused call is logged under ITS channel (matched by tool and channel), and a request the transport rejects as a
// whole is logged as REQUEST_REJECTED, not as an input error.
test("AC-PR-09: in a batch, a refused call keeps its own channel; a request rejected by the transport is REQUEST_REJECTED", async () => {
  await seedTwoChannels();
  const { endpoint, tokens, calls, refused } = setup();
  const token = (await tokens.issueToken({})).token;
  const batch = [
    call("channel_video_list", { channelId: "UC_PR_X", limit: -5 }),
    { ...call("channel_video_list", { channelId: "UC_PR_Y" }), id: 3 },
  ];
  assert.equal((await endpoint.handle(rpc(batch, bearer(token)))).status, 200);
  assert.deepEqual(calls.map((entry) => [entry.tool, entry.channelId, entry.outcome]), [["channel_video_list", "UC_PR_Y", "ok"]]);
  assert.deepEqual(refused, [{ tool: "channel_video_list", channelId: "UC_PR_X", errorCode: "INVALID_PARAMS" }]);

  const noAccept = new Request("http://127.0.0.1:3000/api/mcp/producer", {
    method: "POST",
    headers: { host: "127.0.0.1:3000", "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify(call("producer_list_channels")),
  });
  assert.equal((await endpoint.handle(noAccept)).status, 406);
  assert.deepEqual(refused.at(-1), { tool: "producer_list_channels", channelId: null, errorCode: "REQUEST_REJECTED" });
});

test("AC-PR-09 (review round 3): a tools/call sent as a notification inside a batch is REQUEST_REJECTED, not an input error", async () => {
  await seedTwoChannels();
  const { endpoint, tokens, calls, refused } = setup();
  const token = (await tokens.issueToken({})).token;
  const notification = { jsonrpc: "2.0", method: "tools/call", params: { name: "channel_video_list", arguments: { channelId: "UC_PR_X" } } };
  assert.equal((await endpoint.handle(rpc([call("producer_list_channels"), notification], bearer(token)))).status, 200);
  assert.deepEqual(calls.map((entry) => entry.tool), ["producer_list_channels"]);
  assert.deepEqual(refused, [{ tool: "channel_video_list", channelId: "UC_PR_X", errorCode: "REQUEST_REJECTED" }]);
});

test("AC-PR-09 (review round 4): a notification before the same call in a batch never takes the call's log entry", async () => {
  const { endpoint, tokens, calls, refused } = setup();
  const token = (await tokens.issueToken({})).token;
  const notification = { jsonrpc: "2.0", method: "tools/call", params: { name: "producer_list_channels", arguments: {} } };
  assert.equal((await endpoint.handle(rpc([notification, call("producer_list_channels")], bearer(token)))).status, 200);
  assert.deepEqual(calls.map((entry) => [entry.tool, entry.outcome]), [["producer_list_channels", "ok"]]);
  assert.deepEqual(refused, [{ tool: "producer_list_channels", channelId: null, errorCode: "REQUEST_REJECTED" }]);
});
