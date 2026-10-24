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
import { createStreamLocalizations, localizationsStatusEntry } from "@/lib/live-streams/localizations";
import { readStoredVideoSettings } from "@/lib/live-streams/video-settings";
import { operatorChannelLocalizations } from "@/lib/channel-localizations";

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
      createJob: async (input) => (mediaCalls.push(`createJob:${input.sessionId}${input.storyboardId ? `:${input.storyboardId}/${input.segmentId}` : ""}${input.videoNumber ? `:${input.videoNumber}` : ""}`), { job: { jobId: "j1" } }),
      getJob: async (input) => (mediaCalls.push(`getJob:${input.jobId ?? ""}`), { job: { jobId: "j1" } }),
      cancelJob: async (input) => (mediaCalls.push(`cancelJob:${input.jobId}`), { job: { jobId: input.jobId } }),
      capacityLog: async () => (mediaCalls.push("capacityLog"), { attempts: [] }),
      gpuAvailability: async () => (mediaCalls.push("gpuAvailability"), { availability: {} }),
      gpuAvailabilityLog: async () => (mediaCalls.push("gpuAvailabilityLog"), { log: {} }),
      gpuStats: async () => (mediaCalls.push("gpuStats"), { stats: {} }),
      deleteTemplate: async (input) => (mediaCalls.push(`deleteTemplate:${input.templateId}`), { deleted: true }),
      adoptTemplate: async (input) => (mediaCalls.push(`adoptTemplate:${input.templateId}>${input.newTemplateId}`), { status: "pending" }),
      getSettings: async () => (mediaCalls.push("getSettings"), { settings: {} }),
      // BL-200: pod runtime profiles.
      listRuntimes: async () => (mediaCalls.push("listRuntimes"), { runtimes: [], activeRuntimeId: null }),
      getRuntime: async (input) => (mediaCalls.push(`getRuntime:${input.runtimeId}`), { runtime: { runtimeId: input.runtimeId } }),
      listComfyReleases: async () => (mediaCalls.push("listComfyReleases"), { releases: [] }),
      createRuntime: async (input) => (mediaCalls.push(`createRuntime:${String(input.runtimeId)}`), { runtimeId: input.runtimeId }),
      testRuntime: async (input) => (mediaCalls.push(`testRuntime:${input.runtimeId}`), { test: { runtimeId: input.runtimeId } }),
      setActiveRuntime: async (input) => (mediaCalls.push(`setActiveRuntime:${String(input.runtimeId)}`), { activeRuntimeId: input.runtimeId }),
    },
    // BL-143: the plans core is a fake that records what reached it.
    plans: {
      create: async (input) => (mediaCalls.push(`plan.create:${(input as { planId: string }).planId}`), { plan: {} }),
      importPlan: async () => (mediaCalls.push("plan.import"), { plan: {} }),
      update: async (input) => (mediaCalls.push(`plan.update:${(input as { planId: string }).planId}`), { plan: {} }),
      close: async (input) => (mediaCalls.push(`plan.close:${(input as { planId: string }).planId}`), { plan: {} }),
      get: async (input) => (mediaCalls.push(`plan.get:${(input as { planId: string }).planId}`), { plan: {} }),
      list: async () => (mediaCalls.push("plan.list"), { plans: [] }),
      todo: async (input) => (mediaCalls.push(`plan.todo:${(input as { planId: string }).planId}`), { short: [] }),
      report: async (input) => (mediaCalls.push(`plan.report:${(input as { planId: string }).planId}`), { stored: 1 }),
      runStage: async (input) => (mediaCalls.push(`plan.runStage:${(input as { planId: string }).planId}`), { created: [] }),
      rerun: async (input) => (mediaCalls.push(`plan.rerun:${(input as { planId: string }).planId}`), { created: [] }),
      cloneGroup: async (input) => (mediaCalls.push(`plan.cloneGroup:${(input as { planId: string }).planId}`), { plan: {} }),
      move: async (input) => (mediaCalls.push(`plan.move:${(input as { planId: string }).planId}`), { moved: false }),
      requestRecheck: async (input) => (mediaCalls.push(`plan.requestRecheck:${(input as { recheckId: string }).recheckId}`), { recheck: {} }),
      withdrawRecheck: async (input) => (mediaCalls.push(`plan.withdrawRecheck:${(input as { recheckId: string }).recheckId}`), { recheck: {} }),
    },
    // BL-174: the Gemini module is a fake that records what reached it.
    gemini: {
      getStatus: async () => (mediaCalls.push("gemini.status"), { enabled: false }),
      createJob: async (input) => (mediaCalls.push(`gemini.create:${(input as { channelId: string; dryRun?: boolean }).channelId}${(input as { dryRun?: boolean }).dryRun ? ":dry" : ""}${(input as { videoNumber?: string }).videoNumber ? `:${(input as { videoNumber?: string }).videoNumber}` : ""}`), { job: { jobId: "gm_1" } }),
      getJobs: async (input) => (mediaCalls.push(`gemini.get:${(input as { jobId?: string }).jobId ?? ""}`), { jobs: [] }),
    },
    live: {
      getStatus: async (input) => (mediaCalls.push(`live.status:${input.channelId ?? ""}`), { streams: [] }),
      mapSources: async (input) => (mediaCalls.push(`live.map:${input.channelId}:${input.items.length}`), { results: [] }),
      setLocalizations: async (input) => (mediaCalls.push(`live.localizations:${input.channelId}:${Object.keys(input.localizations).join(",")}`), { localizations: input.localizations, warnings: [] }),
    },
    // BL-210: the channel translations' Operator surface is a fake that records what reached it.
    channelLocalizations: {
      get: async (input) => (mediaCalls.push(`channel.localizations.get:${input.channelId}`), { channelId: input.channelId }),
      save: async (input) => (mediaCalls.push(`channel.localizations.save:${input.channelId}:${Object.keys(input.localizations).join(",")}`), { localizations: input.localizations }),
    },
    // BL-184: the storyboards module is a fake that records what reached it.
    storyboards: {
      create: async (input) => (mediaCalls.push(`sb.create:${(input as { channelId: string }).channelId}`), { storyboard: {} }),
      update: async (input) => (mediaCalls.push(`sb.update:${(input as { storyboardId: string }).storyboardId}`), { storyboard: {}, changed: true }),
      get: async (input) => (mediaCalls.push(`sb.get:${(input as { storyboardId: string }).storyboardId}`), { storyboard: {} }),
      list: async (input) => (mediaCalls.push(`sb.list:${(input as { channelId: string }).channelId}`), { storyboards: [] }),
      submit: async (input) => (mediaCalls.push(`sb.submit:${(input as { storyboardId: string }).storyboardId}`), { storyboard: {} }),
      reply: async (input) => (mediaCalls.push(`sb.reply:${(input as { commentId: string }).commentId}`), { storyboard: {}, replyId: null }),
      attachRender: async (input) => (mediaCalls.push(`sb.render:${(input as { file: string }).file}`), { storyboard: {}, renderId: "rn_1" }),
    },
    // BL-194: the video-projects module is a fake that records what reached it.
    videos: {
      create: async (input) => (mediaCalls.push(`video.create:${(input as { channelId: string }).channelId}`), { video: { video: "V50" } }),
      list: async (input) => (mediaCalls.push(`video.list:${(input as { channelId: string }).channelId}`), { videos: [] }),
      cost: async (input) => (mediaCalls.push(`video.cost:${JSON.stringify(input)}`), { video: "V49", totals: { totalUsd: 1.4088 } }),
    },
    // BL-188: the shared jobs pool is a fake that records what reached it.
    jobs: {
      list: async (input) => (mediaCalls.push(`jobs.list:${input.channelId ?? ""}:${input.source ?? ""}:${input.limit ?? ""}`), { devices: [], jobs: [], total: 0, truncated: false }),
    },
    // BL-220: the restart tools' deps (not exercised here).
    restart: { status: async () => ({}), hold: async () => ({}), release: async () => ({}) },
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
test("AC-FO-07 / AC-FM-13 / AC-FG-08: tools/list over the real endpoint is exactly the four 1.0.0 tools, the eight 1.1.0 media tools, the seven 1.2.0 tools, the three 1.3.0 tools (FO-REQ-0005) and the eight 1.5.0 plan tools (BL-143)", async () => {
  const { endpoint, tokenServices } = setup();
  const { token } = await tokenServices.issueToken({});
  const body = await (await endpoint.handle(rpc(LIST_TOOLS, withToken(token)))).json();
  const names = (body.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
  // BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md §5): the two factory_channel_* tools are listed too.
  assert.deepEqual(names, [
    "factory_channel_get_localizations",
    "factory_channel_save_localizations",
    "factory_gemini_create_job",
    "factory_gemini_get_job",
    "factory_gemini_get_status",
    "factory_get_capabilities",
    "factory_get_logical_path",
    "factory_jobs_list",
    "factory_list_channels",
    "factory_list_logical_paths",
    "factory_live_get_status",
    "factory_live_map_sources",
    "factory_live_save_localizations",
    "factory_media_activate_runtime",
    "factory_media_adopt_template",
    "factory_media_cancel_job",
    "factory_media_cancel_pull",
    "factory_media_capacity_log",
    "factory_media_create_job",
    "factory_media_create_runtime",
    "factory_media_delete_model",
    "factory_media_delete_template",
    "factory_media_get_gpu_availability",
    "factory_media_get_gpu_stats",
    "factory_media_get_job",
    "factory_media_get_pull",
    "factory_media_get_runtime",
    "factory_media_get_session",
    "factory_media_get_settings",
    "factory_media_list_comfy_releases",
    "factory_media_list_gpu_availability_log",
    "factory_media_list_models",
    "factory_media_list_runtimes",
    "factory_media_list_templates",
    "factory_media_pull_model",
    "factory_media_start_session",
    "factory_media_stop_session",
    "factory_media_storage_status",
    "factory_media_sync_templates",
    "factory_media_test_runtime",
    "factory_plan_clone_group",
    "factory_plan_close",
    "factory_plan_create",
    "factory_plan_get",
    "factory_plan_import",
    "factory_plan_list",
    "factory_plan_move",
    "factory_plan_report",
    "factory_plan_request_recheck",
    "factory_plan_rerun",
    "factory_plan_run_stage",
    "factory_plan_todo",
    "factory_plan_update",
    "factory_plan_withdraw_recheck",
    "factory_storyboard_attach_render",
    "factory_storyboard_create",
    "factory_storyboard_get",
    "factory_storyboard_list",
    "factory_storyboard_reply",
    "factory_storyboard_submit",
    "factory_storyboard_update",
    "factory_video_create",
    "factory_video_get_cost",
    "factory_video_list",
  ].concat(["factory_hold_restart", "factory_release_hold", "factory_restart_status"]).sort()); // BL-220: the three restart tools (1.30.0)
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
// FO-REQ-0005: version 1.3.0, delete/adopt a local template (writes) and the settings read. BL-143: 1.5.0 and the plan tools.
// BL-155 (CUDA_HOSTS_PLAN.md "Contract"): 1.7.0 -- additive fields and an error code, no new tool, so the tool lists are unchanged.
// BL-157 (SERVERS_MEDIA_PLAN.md §G): 1.8.0 and the write tool factory_plan_move, last in both lists (declaration order).
// BL-159 (PER_SESSION_CUDA_PLAN.md "Contract"): 1.9.0, no new tool.
// BL-172 (GPU_AVAILABILITY_PLAN.md AC-GA-08): 1.10.0 and the READ tools after the capacity log (declaration order).
// BL-173 (PLAN_RECHECKS_PLAN.md AC-RC-12): 1.11.0 and the two re-check WRITE tools, last in both lists (declaration order).
// BL-174 (GEMINI_MEDIA_PLAN.md AC-GM-13): 1.12.0 and the three Gemini tools, last (declaration order); one of them a write.
// BL-175 (VISUAL_REVIEW_PLAN.md AC-VR-13): 1.13.0, no new tool.
// BL-176 (LIVE_STREAMS_PLAN.md §3.11): 1.14.0 and the two live-stream tools, last (declaration order); the map is a write.
// BL-179 (GEMINI_OMNI_PLAN.md): 1.15.0, no new tool.
// BL-184 (STORYBOARD_PLAN.md §2.6): 1.16.0 and the six storyboard tools, last (declaration order); four of them writes.
// BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.7): 1.17.0 and the read tool factory_jobs_list, last (declaration order).
// BL-189 (STORYBOARD_TAKES_PLAN.md §2.4): 1.18.0 and the write tool factory_storyboard_attach_render after the other storyboard tools.
// BL-194 (VIDEO_COST_PLAN.md §2 stage 1): 1.20.0 and the two video tools, last (declaration order); factory_video_create a write.
// BL-180: 1.21.0 (the Veo 3.1 previews leave the Gemini catalog; no tool is added or removed). BL-134: 1.22.0 (gated HF pulls;
// no tool is added or removed). BL-206 (GPU_STATS_PLAN.md §2.C): 1.26.0 and the READ tool factory_media_get_gpu_stats after the log.
// BL-207 (LIVE_LOCALIZATIONS_PLAN.md §2 stage 4): 1.27.0 and the WRITE tool factory_live_save_localizations after the map.
// BL-208 (GPU_START_FIXES_PLAN.md): 1.28.0, no tool added or removed.
// BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md §5): 1.29.0 and the READ tool factory_channel_get_localizations and the WRITE tool
// factory_channel_save_localizations after the live tools (declaration order).
// BL-220 (RESTART_WHEN_IDLE_PLAN.md "Factory API 1.30.0"): 1.30.0 and the three restart tools, last (declaration order); hold and
// release are writes.
test("factory_get_capabilities reports the factory API version 1.23.0 (BL-200), READ and WRITE, the tool list and the write tools", async () => {
  const { endpoint, tokenServices } = setup();
  const { token } = await tokenServices.issueToken({});
  const result = await toolResult(await endpoint.handle(rpc(call("factory_get_capabilities"), withToken(token))));
  assert.equal(result.isError, false);
  assert.deepEqual(result.payload, {
    role: "factory_operator",
    factoryApiVersion: "1.31.0", // BL-221: factory_video_list gains youtubeVideoId / hasVideoFile (additive); 1.30.0 (BL-220): the three restart tools
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
      "factory_media_list_runtimes",
      "factory_media_get_runtime",
      "factory_media_list_comfy_releases",
      "factory_media_create_runtime",
      "factory_media_test_runtime",
      "factory_media_activate_runtime",
      "factory_media_start_session",
      "factory_media_get_session",
      "factory_media_stop_session",
      "factory_media_create_job",
      "factory_media_get_job",
      "factory_media_cancel_job",
      "factory_media_capacity_log",
      "factory_media_get_gpu_availability",
      "factory_media_list_gpu_availability_log",
      "factory_media_get_gpu_stats",
      "factory_plan_create",
      "factory_plan_import",
      "factory_plan_update",
      "factory_plan_close",
      "factory_plan_get",
      "factory_plan_list",
      "factory_plan_todo",
      "factory_plan_report",
      "factory_plan_run_stage",
      "factory_plan_rerun",
      "factory_plan_clone_group",
      "factory_plan_move",
      "factory_plan_request_recheck",
      "factory_plan_withdraw_recheck",
      "factory_gemini_get_status",
      "factory_gemini_create_job",
      "factory_gemini_get_job",
      "factory_live_get_status",
      "factory_live_map_sources",
      "factory_live_save_localizations",
      "factory_channel_get_localizations",
      "factory_channel_save_localizations",
      "factory_storyboard_create",
      "factory_storyboard_update",
      "factory_storyboard_get",
      "factory_storyboard_list",
      "factory_storyboard_submit",
      "factory_storyboard_reply",
      "factory_storyboard_attach_render",
      "factory_jobs_list",
      "factory_video_create",
      "factory_video_list",
      "factory_video_get_cost",
      "factory_restart_status",
      "factory_hold_restart",
      "factory_release_hold",
    ],
    permissions: ["READ", "WRITE"],
    writeTools: [
      "factory_media_pull_model",
      "factory_media_cancel_pull",
      "factory_media_delete_model",
      "factory_media_sync_templates",
      "factory_media_delete_template",
      "factory_media_adopt_template",
      "factory_media_create_runtime",
      "factory_media_test_runtime",
      "factory_media_activate_runtime",
      "factory_media_start_session",
      "factory_media_stop_session",
      "factory_media_create_job",
      "factory_media_cancel_job",
      "factory_plan_create",
      "factory_plan_import",
      "factory_plan_update",
      "factory_plan_close",
      "factory_plan_report",
      "factory_plan_run_stage",
      "factory_plan_rerun",
      "factory_plan_clone_group",
      "factory_plan_move",
      "factory_plan_request_recheck",
      "factory_plan_withdraw_recheck",
      "factory_gemini_create_job",
      "factory_live_map_sources",
      "factory_live_save_localizations",
      "factory_channel_save_localizations",
      "factory_storyboard_create",
      "factory_storyboard_update",
      "factory_storyboard_submit",
      "factory_storyboard_reply",
      "factory_storyboard_attach_render",
      "factory_video_create",
      "factory_hold_restart",
      "factory_release_hold",
    ],
  });
});

// BL-220 (RESTART_WHEN_IDLE_PLAN.md AC-RI-03/04, "MCP"): the Operator's hold and release are writes behind the device mutation gate;
// the status read is not counted as an MCP call (a poll must not keep the quiet window open); the module's refusal comes back as is.
test("BL-220: factory_hold_restart / factory_release_hold pass the gate first; factory_restart_status is not counted as an MCP call", async () => {
  const reached: string[] = [];
  const toolDeps = fakeToolDeps({
    restart: {
      status: async () => (reached.push("status"), { request: null, waitingFor: [] }),
      hold: async (input) => {
        reached.push(`hold:${JSON.stringify(input)}`);
        if (input.minutes === 0) throw new DomainError({ code: "validation_failed", message: "minutes must be 1-60" });
        return { hold: { holdId: "h1" } };
      },
      release: async (input) => {
        reached.push(`release:${JSON.stringify(input)}`);
        throw new DomainError({ code: "not_found", message: "No such hold" });
      },
    },
  });
  const tokenServices = createFactoryTokenServices({ store: createMemoryTokenStore(), generateSecret: () => "s1" });
  const endpoint = createFactoryMcpEndpoint({
    isConnectionEnabled: async () => true,
    verifyToken: (token) => tokenServices.verifyToken(token),
    createServer: ({ session }) => createFactoryMcpServer(toolDeps.deps, { connectionEnabled: true, session }),
  });
  const { token } = await tokenServices.issueToken({});
  const run = async (name: string, args: Record<string, unknown> = {}) => toolResult(await endpoint.handle(rpc(call(name, args), withToken(token))));

  assert.equal((await run("factory_restart_status")).isError, false);
  assert.deepEqual(toolDeps.outcomes, [], "the status read is not counted");
  assert.deepEqual((await run("factory_hold_restart", { minutes: 10, reason: "watching a run" })).payload, { hold: { holdId: "h1" } });
  assert.deepEqual(toolDeps.outcomes, ["allowed"], "a hold is counted");
  const refused = await run("factory_hold_restart", { minutes: 0, reason: "x" });
  assert.equal(refused.isError, true);
  assert.equal((refused.payload as { error: { code: string } }).error.code, "validation_failed");
  const notOwn = await run("factory_release_hold", { holdId: "h-worker" });
  assert.equal((notOwn.payload as { error: { code: string } }).error.code, "not_found");
  assert.deepEqual(toolDeps.mediaCalls, ["gate", "gate", "gate"], "every write passed the gate");
  assert.deepEqual(reached, ["status", 'hold:{"minutes":10,"reason":"watching a run"}', 'hold:{"minutes":0,"reason":"x"}', 'release:{"holdId":"h-worker"}']);

  toolDeps.gateClosed.value = true;
  reached.length = 0;
  assert.equal((await run("factory_hold_restart", { minutes: 5, reason: "x" })).isError, true);
  assert.deepEqual(reached, [], "a closed gate reaches nothing");
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

// BL-172 (review round 1): the MCP-layer schemas are strict too, so a bad call never reaches the media core.
test("BL-172: the GPU availability tools reject unknown keys and out-of-range values at the MCP boundary, before the media core", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  for (const [name, args] of [
    ["factory_media_get_gpu_availability", { cloud: "COMMUNITY" }],
    ["factory_media_get_gpu_availability", { minCudaVersion: "twelve" }],
    ["factory_media_get_gpu_availability", { minVramGb: -1 }],
    ["factory_media_get_gpu_availability", { gpuTypeIds: [] }],
    ["factory_media_list_gpu_availability_log", { limit: 5001 }],
    ["factory_media_list_gpu_availability_log", { since: "yesterday" }],
    ["factory_media_list_gpu_availability_log", { region: "EU" }],
    // BL-206: the stats tool's schema is strict and bounded too.
    ["factory_media_get_gpu_stats", { from: "last week" }],
    ["factory_media_get_gpu_stats", { hoursUtc: { from: 12, to: 25 } }],
    ["factory_media_get_gpu_stats", { weekdays: [0] }],
    ["factory_media_get_gpu_stats", { gpuTypeIds: [] }],
    ["factory_media_get_gpu_stats", { region: "EU" }],
  ] as const) {
    toolDeps.mediaCalls.length = 0;
    const body = await (await endpoint.handle(rpc(call(name, { ...args }), withToken(token)))).json();
    assert.equal(body.result?.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(String(body.result.content[0].text), /invalid|unrecognized|validation/i, name);
    assert.deepEqual(toolDeps.mediaCalls, [], name);
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
    ["factory_media_get_gpu_availability", {}, "gpuAvailability"],
    ["factory_media_list_gpu_availability_log", { summary: true }, "gpuAvailabilityLog"],
    ["factory_media_get_gpu_stats", { weekdays: [1, 2] }, "gpuStats"],
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

// FO-REQ-0005 item 1, the cause found by independent review: in the running app the media core is built by the
// instrumentation bundle (kept on globalThis), so its refusals are a DomainError from ANOTHER copy of the class. The
// acceptance criterion: deleting a model a local template uses answers `media_model_in_use` with the template ids.
test("FO-REQ-0005: a media refusal thrown as another bundle's DomainError keeps its code and details (never internal_error)", async () => {
  class ForeignDomainError extends Error {
    readonly code: string;
    readonly details: unknown;
    constructor(code: string, message: string, details: unknown) {
      super(message);
      this.name = "DomainError";
      this.code = code;
      this.details = details;
    }
  }
  const usedBy = [{ templateId: "uuid-local-1", version: 1, source: "owner" }];
  const { endpoint, tokenServices } = setup({
    toolDeps: {
      media: {
        ...fakeToolDeps().deps.media,
        deleteModel: async () => {
          throw new ForeignDomainError("media_model_in_use", "models/checkpoints/a.safetensors is used by uuid-local-1 v1 (local); nothing was deleted.", { key: "models/checkpoints/a.safetensors", usedBy });
        },
      },
    },
  });
  const { token } = await tokenServices.issueToken({});
  const result = await toolResult(await endpoint.handle(rpc(call("factory_media_delete_model", { key: "models/checkpoints/a.safetensors" }), withToken(token))));
  assert.equal(result.isError, true);
  const error = (result.payload as { error: { code: string; details: { usedBy: unknown } } }).error;
  assert.equal(error.code, "media_model_in_use");
  assert.deepEqual(error.details.usedBy, usedBy);
});

// BL-143 (ADR 0029): the plan writes pass the device mutation gate first and reach nothing behind a closed one; the plan
// reads do not need it.
test("BL-143: factory_plan writes pass the device mutation gate first; get/list/todo are reads", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const writes: Array<[string, Record<string, unknown>, string]> = [
    ["factory_plan_create", { planId: "p1", title: "T", channelId: "UC_A", stages: [{ stageId: "generate", title: "G", kind: "in_app" }] }, "plan.create:p1"],
    ["factory_plan_import", { plan: { format: "ytm-generation-plan/1" } }, "plan.import"],
    ["factory_plan_update", { planId: "p1", title: "T2" }, "plan.update:p1"],
    ["factory_plan_close", { planId: "p1", status: "completed" }, "plan.close:p1"],
    ["factory_plan_report", { planId: "p1", rows: [{ stageId: "validate" }] }, "plan.report:p1"],
    ["factory_plan_run_stage", { planId: "p1", sessionId: "s1" }, "plan.runStage:p1"],
    ["factory_plan_rerun", { planId: "p1", sessionId: "s1", itemKey: "C1/F1" }, "plan.rerun:p1"],
    ["factory_plan_clone_group", { planId: "p1", groupId: "C1", newGroupId: "C2" }, "plan.cloneGroup:p1"],
    ["factory_plan_move", { planId: "p1", channelId: "UC_target", checkOnly: true }, "plan.move:p1"],
    ["factory_plan_request_recheck", { planId: "p1", itemKey: "C14/V04", attemptRef: "job:1", recheckId: "C14-XL_V04__r1", kind: "revision", title: "резкость", note: "fixed", auditionFile: "R/C14/x__r1.mp3" }, "plan.requestRecheck:C14-XL_V04__r1"],
    ["factory_plan_withdraw_recheck", { planId: "p1", recheckId: "C14-XL_V04__r1" }, "plan.withdrawRecheck:C14-XL_V04__r1"],
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
    ["factory_plan_get", { planId: "p1" }, "plan.get:p1"],
    ["factory_plan_list", {}, "plan.list"],
    ["factory_plan_todo", { planId: "p1" }, "plan.todo:p1"],
  ] as const) {
    toolDeps.mediaCalls.length = 0;
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, { ...args }), withToken(token))))).isError, false, name);
    assert.deepEqual(toolDeps.mediaCalls, [reached], name);
  }
});

// -- BL-159 (PER_SESSION_CUDA_PLAN.md AC-SC-01; FO-REQ-0011 §2.1/§2.4): the start takes one of the accepted CUDA versions and
// passes it on unchanged; anything else is refused at input and never reaches the media core.
test("BL-159: factory_media_start_session passes minCudaVersion on; a value RunPod does not accept is refused before the media core", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const seen: Array<Record<string, unknown>> = [];
  toolDeps.deps.media.startSession = async (input) => (seen.push(input as Record<string, unknown>), { session: { sessionId: "s1" }, approved: true, heldBy: null });
  const ok = await toolResult(await endpoint.handle(rpc(call("factory_media_start_session", { channelId: "UC_A", minCudaVersion: "13.0" }), withToken(token))));
  assert.equal(ok.isError, false);
  assert.equal(seen[0]?.minCudaVersion, "13.0");
  // The shape is checked at the tool; which versions RunPod accepts is the media core's check (sessions.test.ts, AC-SC-01).
  for (const bad of ["13", "abc", 13, "12.8.1"]) {
    // An input-schema refusal is the SDK's own error text ("MCP error -32602 ..."), not a JSON payload.
    const body = await (await endpoint.handle(rpc(call("factory_media_start_session", { channelId: "UC_A", minCudaVersion: bad }), withToken(token)))).json();
    assert.equal(Boolean(body.result?.isError ?? body.error), true, String(bad));
  }
  assert.equal(seen.length, 1, "no refused value reached the media core");
});

// BL-173 (PLAN_RECHECKS_PLAN.md AC-RC-12): the re-check tools' MCP schemas are strict, so a bad call never reaches the plans core.
test("BL-173: the re-check tools reject unknown keys and an unknown kind at the MCP boundary, before the plans core", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const base = { planId: "p1", itemKey: "C14/V03", attemptRef: "job:2", recheckId: "C14-XL_V03__q1", kind: "question", title: "голос на 0:25", note: "a voice?" };
  for (const [name, args] of [
    ["factory_plan_request_recheck", { ...base, extra: 1 }],
    ["factory_plan_request_recheck", { ...base, kind: "remark" }],
    ["factory_plan_request_recheck", { ...base, note: undefined }],
    ["factory_plan_withdraw_recheck", { planId: "p1", recheckId: "x", reason: "because" }],
  ] as const) {
    toolDeps.mediaCalls.length = 0;
    const body = await (await endpoint.handle(rpc(call(name, { ...args }), withToken(token)))).json();
    assert.equal(body.result?.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(String(body.result.content[0].text), /invalid|unrecognized|validation/i, name);
    assert.deepEqual(toolDeps.mediaCalls, [], "nothing reached the gate or the core");
  }
});

// BL-175 (VISUAL_REVIEW_PLAN.md AC-VR-13): the plan tools take the new fields at the MCP boundary and pass them on unchanged:
// reviewReasons (create, update -- null removes), groups' reviewReasons and items' pickTarget, a marker's region in a report.
test("BL-175: factory_plan_create/update/report pass reviewReasons, pickTarget and a marker region on; an unknown top-level key is still refused", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const seen: Array<Record<string, unknown>> = [];
  toolDeps.deps.plans.create = async (input) => (seen.push(input as Record<string, unknown>), { plan: {} });
  toolDeps.deps.plans.update = async (input) => (seen.push(input as Record<string, unknown>), { plan: {} });
  toolDeps.deps.plans.report = async (input) => (seen.push(input as Record<string, unknown>), { stored: 1 });
  const create = {
    planId: "H-0004-C",
    title: "Plan C",
    channelId: "UC_A",
    stages: [{ stageId: "render", title: "R", kind: "external" }],
    groups: [{ groupId: "W1", reviewReasons: ["лишний предмет"] }],
    items: [{ itemKey: "W1/I", groupId: "W1", targetCount: 8, pickTarget: 1 }],
    reviewReasons: ["лестница"],
  };
  const region = { x: 0.25, y: 0.5, r: 0.1 };
  for (const [name, args] of [
    ["factory_plan_create", create],
    ["factory_plan_update", { planId: "H-0004-C", reviewReasons: null, upsertGroups: [{ groupId: "W1", reviewReasons: null }] }],
    ["factory_plan_report", { planId: "H-0004-C", rows: [{ stageId: "owner_review", itemKey: "W1/I", attemptRef: "a1", result: "rejected", markers: [{ start: 0, note: "фонарь", region }] }] }],
  ] as const) {
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, { ...args }), withToken(token))))).isError, false, name);
  }
  assert.deepEqual(seen[0], create);
  assert.deepEqual([seen[1].reviewReasons, (seen[1].upsertGroups as Array<Record<string, unknown>>)[0].reviewReasons], [null, null]);
  assert.deepEqual(((seen[2].rows as Array<Record<string, unknown>>)[0].markers as unknown[])[0], { start: 0, note: "фонарь", region });
  const body = await (await endpoint.handle(rpc(call("factory_plan_create", { ...create, reviewChips: [] }), withToken(token)))).json();
  assert.equal(body.result?.isError, true, "the create schema stays strict");
});

// BL-174 (GEMINI_MEDIA_PLAN.md AC-GM-13): a paid Gemini job passes the device mutation gate first and reaches nothing behind a
// closed one; a dry-run and the two reads need no gate; the MCP schemas are strict, so a bad call never reaches the module.
test("BL-174: factory_gemini_create_job passes the gate first (a dry-run does not); the reads need no gate; strict schemas", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const job = { channelId: "UC_A", kind: "image", model: "gemini-nano-banana-2.1", prompt: "a cat", image: { size: "1K", aspectRatio: "1:1" } };
  toolDeps.mediaCalls.length = 0;
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_gemini_create_job", job), withToken(token))))).isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ["gate", "gemini.create:UC_A"]);
  toolDeps.mediaCalls.length = 0;
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_gemini_create_job", { ...job, dryRun: true }), withToken(token))))).isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ["gemini.create:UC_A:dry"], "a dry-run is a read");
  for (const [name, args, reached] of [
    ["factory_gemini_get_status", {}, "gemini.status"],
    ["factory_gemini_get_job", { jobId: "gm_1" }, "gemini.get:gm_1"],
  ] as const) {
    toolDeps.mediaCalls.length = 0;
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, { ...args }), withToken(token))))).isError, false, name);
    assert.deepEqual(toolDeps.mediaCalls, [reached], name);
  }
  toolDeps.gateClosed.value = true;
  toolDeps.mediaCalls.length = 0;
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_gemini_create_job", job), withToken(token))))).isError, true);
  assert.deepEqual(toolDeps.mediaCalls, ["gate"], "nothing reached the module behind a closed gate");
  toolDeps.gateClosed.value = false;
  for (const [name, args] of [
    ["factory_gemini_create_job", { ...job, extra: 1 }],
    ["factory_gemini_create_job", { ...job, kind: "audio" }],
    ["factory_gemini_create_job", { ...job, image: { size: "1K", aspectRatio: "1:1", mask: "m.png" } }],
    ["factory_gemini_get_job", { jobId: "gm_1", verbose: true }],
    ["factory_gemini_get_status", { all: true }],
  ] as const) {
    toolDeps.mediaCalls.length = 0;
    const body = await (await endpoint.handle(rpc(call(name, { ...args }), withToken(token)))).json();
    assert.equal(body.result?.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(String(body.result.content[0].text), /invalid|unrecognized|validation/i, name);
    assert.deepEqual(toolDeps.mediaCalls, [], "nothing reached the gate or the module");
  }
});

// BL-176 (LIVE_STREAMS_PLAN.md §3.4/§3.11): the map is a local write that passes the gate first; the status read needs none;
// both schemas are strict (an 11-character video id, 1-200 items, no extra field).
test("BL-176: factory_live_map_sources passes the gate first; factory_live_get_status needs no gate; strict schemas", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const map = { channelId: "UC_A", items: [{ videoId: "AAAAAAAAAA1", file: "04 Videos/a.mp4" }] };
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_live_map_sources", map), withToken(token))))).isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ["gate", "live.map:UC_A:1"]);
  toolDeps.mediaCalls.length = 0;
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_live_get_status", { channelId: "UC_A" }), withToken(token))))).isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ["live.status:UC_A"]);
  toolDeps.mediaCalls.length = 0;
  for (const bad of [{ ...map, items: [{ videoId: "short", file: "x" }] }, { ...map, items: [] }, { ...map, extra: 1 }, { channelId: "UC_A" }]) {
    // Refused either by the SDK's own schema check or by the tool's strict parse: an error result either way.
    const body = await (await endpoint.handle(rpc(call("factory_live_map_sources", bad), withToken(token)))).json();
    assert.equal(Boolean(body.result?.isError ?? body.error), true, JSON.stringify(bad));
  }
  assert.deepEqual(toolDeps.mediaCalls, [], "an invalid input reaches neither the gate nor the module");
});

// BL-207 (LIVE_LOCALIZATIONS_PLAN.md AC-LL-10): factory_live_save_localizations is a local write that passes the gate first; its
// input is strict (channelId + localizations of { title, description } only); {} is a valid set (it clears).
test("AC-LL-10: factory_live_save_localizations passes the gate first; strict schema; {} accepted", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const ok = { channelId: "UC_A", localizations: { de: { title: "Dt", description: "Dd" } } };
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_live_save_localizations", ok), withToken(token))))).isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ["gate", "live.localizations:UC_A:de"]);
  toolDeps.mediaCalls.length = 0;
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_live_save_localizations", { channelId: "UC_A", localizations: {} }), withToken(token))))).isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ["gate", "live.localizations:UC_A:"]);
  toolDeps.mediaCalls.length = 0;
  for (const bad of [
    { ...ok, extra: 1 },
    { channelId: "UC_A" },
    { localizations: {} },
    { channelId: "UC_A", localizations: { de: { title: "Dt", description: "Dd", tags: ["x"] } } },
    { channelId: "UC_A", localizations: { de: { title: "Dt" } } },
    { channelId: "UC_A", localizations: { de: "Dt" } },
    { channelId: "UC_A", localizations: [] },
  ]) {
    const body = await (await endpoint.handle(rpc(call("factory_live_save_localizations", bad), withToken(token)))).json();
    assert.equal(Boolean(body.result?.isError ?? body.error), true, JSON.stringify(bad));
  }
  assert.deepEqual(toolDeps.mediaCalls, [], "an invalid input reaches neither the gate nor the module");
});

/** The real translations store of the live-streams module over one in-memory row (null = no stream on this computer). */
function liveLocalizationsOverMemory(initial: { localizationsJson?: string | null; videoSettingsJson?: string | null } | null) {
  let row: Record<string, unknown> | null = initial ? { channelId: "UC_A", localizationsJson: null, ...initial } : null;
  const events: Array<{ kind: string; detail: unknown }> = [];
  const service = createStreamLocalizations({
    store: {
      getStream: async () => row as never,
      updateStream: async (_channelId, set) => {
        if (!row) return false;
        row = { ...row, ...set };
        return true;
      },
      insertEvent: async (event) => {
        events.push({ kind: event.kind, detail: JSON.parse(event.detailJson) });
      },
    },
    channelLanguage: async () => "en",
    readVideoSettings: readStoredVideoSettings,
    lastApplied: async () => null,
    clock: () => new Date("2026-10-21T10:00:00Z"),
    newId: () => "e1",
  });
  const live: FactoryToolDeps["live"] = {
    getStatus: async () => ({ streams: [], segments: [], localizations: row ? [localizationsStatusEntry("UC_A", await service.view("UC_A"))] : [] }),
    mapSources: async () => ({ results: [] }),
    setLocalizations: async (input) => ({ ...(await service.save(input.channelId, input.localizations, "factory")) }),
  };
  return { live, events, row: () => row };
}

// AC-LL-07 through the MCP tool (values by hand from the plan): each refused language comes back with its reason, the whole call
// is refused and nothing is stored; 2500 × "é" (5000 bytes) is accepted. AC-LL-10: no stream here = live_stream_not_found, and
// factory_live_get_status shows the saved set (with the not-saved-video-settings warning, owner msg 3287).
test("AC-LL-07 / AC-LL-10: refusals per language through MCP, nothing stored; live_stream_not_found; get_status shows the set", async () => {
  const before = JSON.stringify({ fr: { title: "Ft", description: "Fd" } });
  const memory = liveLocalizationsOverMemory({ localizationsJson: before });
  const { endpoint, tokenServices } = setup({ toolDeps: { live: memory.live } });
  const { token } = await tokenServices.issueToken({});
  const send = async (localizations: unknown) => toolResult(await endpoint.handle(rpc(call("factory_live_save_localizations", { channelId: "UC_A", localizations }), withToken(token))));

  const cases: Array<[Record<string, unknown>, Array<[string, string]>]> = [
    [{ de: { title: "", description: "D" } }, [["de", "title_empty"]]],
    [{ de: { title: "x".repeat(101), description: "D" } }, [["de", "title_too_long"]]],
    [{ de: { title: "T", description: "é".repeat(2501) } }, [["de", "description_too_long"]]],
    [{ de: { title: "T", description: "" } }, [["de", "description_empty"]]],
    [{ de: { title: "Jazz <live>", description: "D" } }, [["de", "title_angle_brackets"]]],
    [{ "pt-br": { title: "T", description: "D" }, xx: { title: "T", description: "D" }, de: { title: "T", description: "D" } }, [["pt-br", "unsupported_language"], ["xx", "unsupported_language"]]],
    [{ en: { title: "T", description: "D" } }, [["en", "baseline_language"]]],
  ];
  for (const [localizations, refused] of cases) {
    const result = await send(localizations);
    assert.equal(result.isError, true, JSON.stringify(localizations).slice(0, 80));
    const error = result.payload.error as { code: string; details: { refused: Array<{ language: string; reason: string; hint?: string }> } };
    assert.equal(error.code, "validation_failed");
    assert.deepEqual(error.details.refused.map((r) => [r.language, r.reason]), refused);
  }
  // pt-br carries the hint pt-BR.
  const hinted = await send({ "pt-br": { title: "T", description: "D" } });
  assert.equal((hinted.payload.error as { details: { refused: Array<{ hint?: string }> } }).details.refused[0].hint, "pt-BR");
  // 51 languages: the set as a whole is refused.
  const codes = ["de", "fr", "it", "es", "ja", "ko", "nl", "pl", "pt-BR", "pt-PT", "sv", "tr", "uk", "cs", "da", "fi", "el", "hu", "id", "ms", "no", "ro", "sk", "th", "vi", "zh-CN", "zh-TW", "ar", "he", "hi", "bn", "bg", "hr", "et", "lv", "lt", "sl", "sr", "ca", "eu", "gl", "is", "ga", "mt", "sq", "mk", "ka", "hy", "az", "kk", "uz"];
  assert.equal(codes.length, 51);
  const tooMany = await send(Object.fromEntries(codes.map((c) => [c, { title: "T", description: "D" }])));
  assert.equal(tooMany.isError, true);
  assert.equal((tooMany.payload.error as { details: { problem: string } }).details.problem, "too_many_languages");
  // Nothing of any refused call was stored, and no event was written.
  assert.equal(memory.row()!.localizationsJson, before);
  assert.deepEqual(memory.events, []);

  // Accepted: the set replaces the stored one (fr is gone), 5000 bytes allowed; the warning says the video settings are not saved.
  const accepted = await send({ de: { title: " Dt ", description: "é".repeat(2500) } });
  assert.equal(accepted.isError, false);
  assert.deepEqual(accepted.payload.localizations, { de: { title: "Dt", description: "é".repeat(2500) } });
  assert.deepEqual((accepted.payload.warnings as Array<{ code: string }>).map((w) => w.code), ["video_settings_not_saved"]);
  assert.deepEqual(memory.events, [{ kind: "localizations_saved", detail: { languages: ["de"], by: "factory" } }]);

  const status = await toolResult(await endpoint.handle(rpc(call("factory_live_get_status", { channelId: "UC_A" }), withToken(token))));
  assert.deepEqual(status.payload.localizations, [
    { channelId: "UC_A", localizations: { de: { title: "Dt", description: "é".repeat(2500) } }, problem: null, warnings: ["video_settings_not_saved"], lastStep: null },
  ]);

  // No stream on this computer.
  const none = liveLocalizationsOverMemory(null);
  const other = setup({ toolDeps: { live: none.live } });
  const { token: otherToken } = await other.tokenServices.issueToken({});
  const missing = await toolResult(await other.endpoint.handle(rpc(call("factory_live_save_localizations", { channelId: "UC_A", localizations: { de: { title: "T", description: "D" } } }), withToken(otherToken))));
  assert.equal(missing.isError, true);
  assert.equal((missing.payload.error as { code: string }).code, "live_stream_not_found");
});

test("AC-LL-10: get_status reports the last localizations step in codes, never the error text", () => {
  const entry = localizationsStatusEntry("UC_A", {
    localizations: { de: { title: "Dt", description: "Dd" } },
    problem: null,
    warnings: [],
    lastStep: { at: "2026-10-21T09:00:00.000Z", broadcastId: "B1", ok: false, error: "YouTube reads back something else: de missing" },
  });
  assert.deepEqual(entry.lastStep, { at: "2026-10-21T09:00:00.000Z", broadcastId: "B1", ok: false, failure: "read_back_mismatch" });
  const other = localizationsStatusEntry("UC_A", { localizations: null, problem: "the saved translations are not valid JSON", warnings: [], lastStep: { at: "x", broadcastId: null, ok: false, error: "Live writes are off" } });
  assert.equal(other.problem, "invalid_stored");
  assert.deepEqual(other.lastStep, { at: "x", broadcastId: null, ok: false, failure: "failed" });
  assert.equal(JSON.stringify(other).includes("Live writes are off"), false);
});

// BL-184 (STORYBOARD_PLAN.md §2.6): the four storyboard writes pass the device mutation gate first and reach nothing behind a closed
// one; the two reads need no gate; an unknown field is refused before the module is reached.
test("BL-184: factory_storyboard_* writes pass the gate first, reads do not; strict schemas", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const content = { title: "Bar loop", loop: true, keyframes: [{ id: "K0", file: "Sent to YTM/a.jpg" }], segments: [] };
  const writes: Array<[string, Record<string, unknown>, string]> = [
    ["factory_storyboard_create", { channelId: "UC_A", ...content }, "sb.create:UC_A"],
    ["factory_storyboard_update", { channelId: "UC_A", storyboardId: "sb1", ...content }, "sb.update:sb1"],
    ["factory_storyboard_submit", { channelId: "UC_A", storyboardId: "sb1" }, "sb.submit:sb1"],
    ["factory_storyboard_reply", { channelId: "UC_A", storyboardId: "sb1", commentId: "c1", resolve: true }, "sb.reply:c1"],
    // BL-189 (FO-REQ-0025 B): the final file of an approved version.
    ["factory_storyboard_attach_render", { channelId: "UC_A", storyboardId: "sb1", versionNumber: 3, file: "Sent to YTM/bar/v3/loop.mp4", picks: { S1: { source: "media", jobId: "j1" } }, notes: "s8" }, "sb.render:Sent to YTM/bar/v3/loop.mp4"],
  ];
  for (const [name, args, reached] of writes) {
    toolDeps.mediaCalls.length = 0;
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, args), withToken(token))))).isError, false, name);
    assert.deepEqual(toolDeps.mediaCalls, ["gate", reached], name);
  }
  for (const [name, args, reached] of [
    ["factory_storyboard_get", { channelId: "UC_A", storyboardId: "sb1" }, "sb.get:sb1"],
    ["factory_storyboard_list", { channelId: "UC_A", state: "in_review" }, "sb.list:UC_A"],
  ] as const) {
    toolDeps.mediaCalls.length = 0;
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, { ...args }), withToken(token))))).isError, false, name);
    assert.deepEqual(toolDeps.mediaCalls, [reached], `${name} is not gated`);
  }
  toolDeps.gateClosed.value = true;
  for (const [name, args] of writes) {
    toolDeps.mediaCalls.length = 0;
    assert.equal((await toolResult(await endpoint.handle(rpc(call(name, args), withToken(token))))).isError, true, name);
    assert.deepEqual(toolDeps.mediaCalls, ["gate"], `${name} reached nothing behind a closed gate`);
  }
  toolDeps.gateClosed.value = false;
  toolDeps.mediaCalls.length = 0;
  for (const [name, bad] of [
    ["factory_storyboard_submit", { channelId: "UC_A", storyboardId: "sb1", approve: true }],
    ["factory_storyboard_list", { channelId: "UC_A", state: "generating" }],
    ["factory_storyboard_create", { channelId: "UC_A", ...content, approved: true }],
    // BL-189: the owner's verdict is never the Operator's to send.
    ["factory_storyboard_attach_render", { channelId: "UC_A", storyboardId: "sb1", versionNumber: 3, file: "Sent to YTM/a.mp4", approved: true }],
    ["factory_storyboard_attach_render", { channelId: "UC_A", storyboardId: "sb1", file: "Sent to YTM/a.mp4" }],
  ] as const) {
    const body = await (await endpoint.handle(rpc(call(name, bad), withToken(token)))).json();
    assert.equal(Boolean(body.result?.isError ?? body.error), true, JSON.stringify(bad));
  }
  assert.deepEqual(toolDeps.mediaCalls, [], "an invalid input reaches neither the gate nor the module");
});

// BL-184 stage 2 (STORYBOARD_PLAN.md §2.6): the job tools take the storyboard segment a video renders; the fields reach the modules
// (which check them with the storyboard gate); an unknown field next to them is still refused.
test("BL-184: storyboardId / segmentId on factory_media_create_job and factory_gemini_create_job reach the modules", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const link = { storyboardId: "bar-loop", segmentId: "S1" };
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_media_create_job", { sessionId: "s1", templateId: "t1", params: { prompt: "x" }, ...link }), withToken(token))))).isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ["gate", "createJob:s1:bar-loop/S1"]);
  toolDeps.mediaCalls.length = 0;
  const gemini = { channelId: "UC_A", kind: "video", model: "gemini-omni-1.1-flash", prompt: "bar", video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, inputs: { firstFrame: "bar/v2/K0.jpg", lastFrame: "bar/v2/K1.jpg" } }, ...link };
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_gemini_create_job", gemini), withToken(token))))).isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ["gate", "gemini.create:UC_A"]);
  toolDeps.mediaCalls.length = 0;
  const body = await (await endpoint.handle(rpc(call("factory_media_create_job", { sessionId: "s1", templateId: "t1", params: {}, ...link, approved: true }), withToken(token)))).json();
  assert.equal(Boolean(body.result?.isError ?? body.error), true);
  assert.deepEqual(toolDeps.mediaCalls, []);
});

// BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.7, AC 9; owner msg 2806 item 4): factory_jobs_list is a read -- no device gate -- and passes
// its filters to the pool; an unknown field (e.g. a command) or an out-of-range limit is refused before the pool is reached.
test("BL-188: factory_jobs_list is a read without the gate; strict filters; nothing invalid reaches the pool", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const ok = await toolResult(await endpoint.handle(rpc(call("factory_jobs_list", { channelId: "UC_A", source: "gemini", limit: 500 }), withToken(token))));
  assert.equal(ok.isError, false);
  assert.deepEqual(ok.payload, { devices: [], jobs: [], total: 0, truncated: false });
  assert.deepEqual(toolDeps.mediaCalls, ["jobs.list:UC_A:gemini:500"], "a read is not gated");
  toolDeps.gateClosed.value = true;
  toolDeps.mediaCalls.length = 0;
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_jobs_list", {}), withToken(token))))).isError, false, "a closed gate does not stop a read");
  assert.deepEqual(toolDeps.mediaCalls, ["jobs.list:::"]);
  toolDeps.gateClosed.value = false;
  toolDeps.mediaCalls.length = 0;
  for (const bad of [{ limit: 501 }, { limit: 0 }, { source: "comfy" }, { mediaKind: "music" }, { status: "Done!" }, { cancel: "rp1" }, { targetDeviceId: "mac" }]) {
    const body = await (await endpoint.handle(rpc(call("factory_jobs_list", bad), withToken(token)))).json();
    assert.equal(Boolean(body.result?.isError ?? body.error), true, JSON.stringify(bad));
  }
  assert.deepEqual(toolDeps.mediaCalls, [], "an invalid input never reaches the pool");
});

// BL-194 (VIDEO_COST_PLAN.md §2 stage 1): factory_video_create is a write behind the device mutation gate, factory_video_list a read;
// both strict; videoNumber on the job tools reaches the modules (which check it against the channel).
test("BL-194: factory_video_create passes the gate first, factory_video_list does not; strict schemas; videoNumber reaches the job modules", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const created = await toolResult(await endpoint.handle(rpc(call("factory_video_create", { channelId: "UC_A", workingTitle: "Jazz bar" }), withToken(token))));
  assert.equal(created.isError, false);
  assert.deepEqual(created.payload, { video: { video: "V50" } });
  assert.deepEqual(toolDeps.mediaCalls, ["gate", "video.create:UC_A"]);
  toolDeps.mediaCalls.length = 0;
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_video_list", { channelId: "UC_A", state: "in_work" }), withToken(token))))).isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ["video.list:UC_A"], "a read is not gated");
  toolDeps.gateClosed.value = true;
  toolDeps.mediaCalls.length = 0;
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_video_create", { channelId: "UC_A" }), withToken(token))))).isError, true);
  assert.deepEqual(toolDeps.mediaCalls, ["gate"], "nothing reserved behind a closed gate");
  toolDeps.gateClosed.value = false;
  toolDeps.mediaCalls.length = 0;
  for (const [name, bad] of [
    ["factory_video_create", { channelId: "UC_A", video: "V60" }],
    ["factory_video_create", {}],
    ["factory_video_list", { channelId: "UC_A", state: "draft" }],
  ] as const) {
    const body = await (await endpoint.handle(rpc(call(name, bad), withToken(token)))).json();
    assert.equal(Boolean(body.result?.isError ?? body.error), true, JSON.stringify(bad));
  }
  assert.deepEqual(toolDeps.mediaCalls, [], "an invalid input reaches neither the gate nor the module");
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_media_create_job", { sessionId: "s1", templateId: "t1", params: {}, videoNumber: "V49" }), withToken(token))))).isError, false);
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_gemini_create_job", { channelId: "UC_A", kind: "image", model: "m", prompt: "p", videoNumber: "V49" }), withToken(token))))).isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ["gate", "createJob:s1:V49", "gate", "gemini.create:UC_A:V49"]);
});

// BL-194 stage 3 (VIDEO_COST_PLAN.md §2 stage 3, ADR 0041): factory_video_get_cost is a read (no mutation gate), strict, and passes
// the channel and the video to the cost module as given.
test("BL-194: factory_video_get_cost is a read with a strict schema that reaches the cost module", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const ok = await toolResult(await endpoint.handle(rpc(call("factory_video_get_cost", { channelId: "UC_A", video: "V49" }), withToken(token))));
  assert.equal(ok.isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ['video.cost:{"channelId":"UC_A","video":"V49"}'], "a read is not gated");
  toolDeps.mediaCalls.length = 0;
  for (const bad of [{ channelId: "UC_A", video: "V049" }, { channelId: "UC_A", video: "V49", extra: 1 }, { channelId: "UC_A" }]) {
    const body = await (await endpoint.handle(rpc(call("factory_video_get_cost", bad), withToken(token)))).json();
    assert.equal(Boolean(body.result?.isError ?? body.error), true, JSON.stringify(bad));
  }
  assert.deepEqual(toolDeps.mediaCalls, [], "an invalid input never reaches the module");
});

// BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md §5, AC-CL-01/10): factory_channel_save_localizations is a local write that passes the gate
// first and reaches only the module's save; its input is strict; factory_channel_get_localizations is a read (no gate).
test("AC-CL-10: factory_channel_save_localizations passes the gate first; strict schema; get is a read without the gate", async () => {
  const { endpoint, tokenServices, toolDeps } = setupWithDeps();
  const { token } = await tokenServices.issueToken({});
  const ok = { channelId: "UC_A", localizations: { de: { title: "Dt", description: "Dd" } } };
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_channel_save_localizations", ok), withToken(token))))).isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ["gate", "channel.localizations.save:UC_A:de"]);
  toolDeps.mediaCalls.length = 0;
  assert.equal((await toolResult(await endpoint.handle(rpc(call("factory_channel_get_localizations", { channelId: "UC_A" }), withToken(token))))).isError, false);
  assert.deepEqual(toolDeps.mediaCalls, ["channel.localizations.get:UC_A"]);
  toolDeps.mediaCalls.length = 0;
  for (const [tool, bad] of [
    ["factory_channel_save_localizations", { ...ok, apply: true }],
    ["factory_channel_save_localizations", { channelId: "UC_A" }],
    ["factory_channel_save_localizations", { channelId: "UC_A", localizations: { de: { title: "Dt", description: "Dd", tags: [] } } }],
    ["factory_channel_save_localizations", { channelId: "UC_A", localizations: [] }],
    ["factory_channel_get_localizations", { channelId: "UC_A", live: false }],
    ["factory_channel_get_localizations", {}],
  ] as const) {
    const body = await (await endpoint.handle(rpc(call(tool, bad), withToken(token)))).json();
    assert.equal(Boolean(body.result?.isError ?? body.error), true, JSON.stringify(bad));
  }
  assert.deepEqual(toolDeps.mediaCalls, [], "an invalid input reaches neither the gate nor the module");
});

// BL-210 AC-CL-11 (values by hand from the plan §5): get returns the stored set, the live translations and the last apply -- the last
// apply in codes (never the owner's error text or the backup path); a live read that cannot be made gives live null and its code.
test("AC-CL-11: factory_channel_get_localizations returns the stored set, the live localizations and the last result", async () => {
  const view = {
    channelId: "UC_A",
    localizations: { de: { title: "Dt", description: "Dd" } },
    problem: null,
    baselineLanguage: "en",
    updatedAt: "2026-10-22T09:00:00.000Z",
    updatedBy: "factory" as const,
    lastApply: { at: "2026-10-22T10:00:00.000Z", ok: false as const, failure: "failed" as const, detail: "live_writes_disabled", error: "Real YouTube write execution is disabled", languages: ["de"], writes: 0, backupPath: "/Users/x/backups/UC_A/op/UC_A.json" },
  };
  const surface = {
    view: async () => view,
    live: async () => ({ defaultLanguage: "en", localizations: { fr: { title: "Ft", description: "Fd" } } }),
    save: async () => ({ localizations: {} }),
  };
  const { endpoint, tokenServices } = setup({
    toolDeps: { channelLocalizations: { get: (input) => operatorChannelLocalizations(surface, input.channelId), save: async () => ({}) } },
  });
  const { token } = await tokenServices.issueToken({});
  const result = await toolResult(await endpoint.handle(rpc(call("factory_channel_get_localizations", { channelId: "UC_A" }), withToken(token))));
  assert.equal(result.isError, false);
  assert.deepEqual(result.payload, {
    channelId: "UC_A",
    stored: { localizations: { de: { title: "Dt", description: "Dd" } }, problem: null, baselineLanguage: "en", updatedAt: "2026-10-22T09:00:00.000Z", updatedBy: "factory" },
    live: { defaultLanguage: "en", localizations: { fr: { title: "Ft", description: "Fd" } } },
    liveUnavailable: null,
    lastApply: { at: "2026-10-22T10:00:00.000Z", ok: false, languages: ["de"], writes: 0, failure: "failed", code: "live_writes_disabled" },
  });

  const unreadable = await operatorChannelLocalizations(
    { ...surface, live: async () => Promise.reject(new DomainError({ code: "data_api_reads_disabled", message: "off" })) },
    "UC_A"
  );
  assert.equal(unreadable.live, null);
  assert.equal(unreadable.liveUnavailable, "data_api_reads_disabled");
});
