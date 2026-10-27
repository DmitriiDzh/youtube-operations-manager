import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MCP_TOOL_CLASSIFICATION } from "./tool-classification";
import { createFactoryMcpServer, FACTORY_API_VERSION, FACTORY_TOOL_NAMES, FACTORY_WRITE_TOOL_NAMES } from "./factory-server";

// Mechanical enforcement from docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md §2.5 (AC-FO-07, AC-FO-09,
// AC-FO-13): the Factory Operator's tool set is closed and separate from the channel agents' tool set.

// BL-132 (FACTORY_MEDIA_CONTROL_PLAN.md §2.6, ADR 0025): eight media tools join the four 1.0.0 tools; BL-133
// (FACTORY_GPU_SESSIONS_PLAN.md, ADR 0026): seven more -- its own sessions, jobs in them, the capacity log.
// BL-174 (GEMINI_MEDIA_PLAN.md §2.7): three Gemini tools (two reads, one write).
// BL-176 (LIVE_STREAMS_PLAN.md §3.4/§3.11): two live-stream tools (a status read, a local map write).
// BL-184 (STORYBOARD_PLAN.md §2.6): six storyboard tools (four writes, two reads).
// BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.7): factory_jobs_list, a read (owner msg 2806: the Operator only sees other computers' jobs).
// BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md §5): a channel's translations -- factory_channel_get_localizations (a read) and
// factory_channel_save_localizations (a local write).
// BL-220 (RESTART_WHEN_IDLE_PLAN.md "Factory API 1.30.0"): factory_restart_status (a read), factory_hold_restart and
// factory_release_hold (local writes).
// BL-223 (CHANNEL_BRANDING_PLAN.md §5): factory_channel_get_branding (a read) and factory_channel_save_branding (a local write).
// BL-225 (WEEKLY_PUBLISHING_PLAN.md stage 1 item 5): factory_publishing_plan_save (a local write), _get and _list (reads).
const EXPECTED_TOOLS = [
  "factory_channel_get_branding",
  "factory_channel_get_localizations",
  "factory_channel_save_branding",
  "factory_channel_save_localizations",
  "factory_gemini_create_job",
  "factory_gemini_get_job",
  "factory_gemini_get_status",
  "factory_get_capabilities",
  "factory_get_logical_path",
  "factory_hold_restart",
  "factory_jobs_list",
  "factory_list_channels",
  "factory_list_logical_paths",
  "factory_live_get_status",
  "factory_live_map_sources",
  "factory_live_save_localizations",
  "factory_localization_report_checks",
  "factory_localization_request_claim",
  "factory_localization_request_complete",
  "factory_localization_request_fail",
  "factory_localization_requests_list",
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
  "factory_publishing_plan_get",
  "factory_publishing_plan_list",
  "factory_publishing_plan_save",
  "factory_release_hold",
  "factory_restart_status",
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
];

function registeredNames(): string[] {
  const server = createFactoryMcpServer(
    {
      async readLogicalPath() { return { name: "x", path: "y" }; },
      async listLogicalPaths() { return []; },
      async listChannels() { return []; },
      async recordOutcome() {},
      media: {} as never,
      plans: {} as never,
      gemini: {} as never,
      live: {} as never,
      channelLocalizations: {} as never,
      channelBranding: {} as never,
      publishingPlans: {} as never,
      localizationChecks: {} as never,
      storyboards: {} as never,
      jobs: {} as never,
      videos: {} as never,
      restart: {} as never,
      async assertMutationAllowed() {},
    },
    { connectionEnabled: true, session: { tokenId: "t", async reverify() {} } }
  );
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
}

test("§2.5(1): the factory server registers exactly the explicit allowlist, and nothing else", () => {
  assert.deepEqual(registeredNames(), EXPECTED_TOOLS);
  assert.deepEqual([...FACTORY_TOOL_NAMES].sort(), EXPECTED_TOOLS);
});

test("§2.5(2): no factory tool is classified for channel sessions, and the factory server registers no channel tool", () => {
  for (const name of Object.keys(MCP_TOOL_CLASSIFICATION)) {
    assert.equal(name.startsWith("factory_"), false, `${name} must not be a channel-session tool`);
  }
  const channelTools = new Set(Object.keys(MCP_TOOL_CLASSIFICATION));
  for (const name of registeredNames()) assert.equal(channelTools.has(name), false, name);
});

test("§2.5(2): the channel-agent server's source never registers a factory_ tool", async () => {
  const source = await readFile("src/mcp/server.ts", "utf8");
  assert.equal(/registerTool\(\s*"factory_/.test(source), false);
  assert.equal(source.includes("factory-server"), false);
});

// AC-FO-09 as amended by ADR 0025 (BL-132) and ADR 0026 (BL-133): the factory writes ONLY through the tools named in
// FACTORY_WRITE_TOOL_NAMES (four media actions, then its own sessions and jobs; FO-REQ-0005 adds deleting and adopting a
// local template; BL-143 / ADR 0029 adds its generation plans: create, import, update, close, report); every other tool is a read; no tool sets a path, a workspace or a token, and none approves or rejects a
// session for anyone else.
test("AC-FO-09 (amended by ADR 0025/0026): writes are exactly the named media/session/job actions; everything else is a read; nothing sets a path, workspace or token", () => {
  // BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md §5): the channel translations save is a write (local only; the plan names it a WRITE tool).
  // BL-223 (CHANNEL_BRANDING_PLAN.md §5): the branding draft save is a write (local only; the plan names it WRITE to local storage).
  assert.deepEqual([...FACTORY_WRITE_TOOL_NAMES].sort(), [
    "factory_channel_save_branding",
    "factory_channel_save_localizations",
    "factory_gemini_create_job",
    "factory_hold_restart",
    "factory_live_map_sources",
    "factory_live_save_localizations",
    "factory_localization_report_checks",
    "factory_localization_request_claim",
    "factory_localization_request_complete",
    "factory_localization_request_fail",
    "factory_media_activate_runtime",
    "factory_media_adopt_template",
    "factory_media_cancel_job",
    "factory_media_cancel_pull",
    "factory_media_create_job",
    "factory_media_create_runtime",
    "factory_media_delete_model",
    "factory_media_delete_template",
    "factory_media_pull_model",
    "factory_media_start_session",
    "factory_media_stop_session",
    "factory_media_sync_templates",
    "factory_media_test_runtime",
    "factory_plan_clone_group",
    "factory_plan_close",
    "factory_plan_create",
    "factory_plan_import",
    "factory_plan_move",
    "factory_plan_report",
    "factory_plan_request_recheck",
    "factory_plan_rerun",
    "factory_plan_run_stage",
    "factory_plan_update",
    "factory_plan_withdraw_recheck",
    "factory_publishing_plan_save",
    "factory_release_hold",
    "factory_storyboard_attach_render",
    "factory_storyboard_create",
    "factory_storyboard_reply",
    "factory_storyboard_submit",
    "factory_storyboard_update",
    "factory_video_create",
  ]);
  const writes = new Set<string>(FACTORY_WRITE_TOOL_NAMES);
  for (const name of FACTORY_TOOL_NAMES) {
    // BL-174: the Gemini reads are factory_gemini_get_*; BL-176: the live-stream read is factory_live_get_status; BL-184: the
    // storyboard reads are factory_storyboard_get / factory_storyboard_list; BL-188: factory_jobs_list; BL-194: factory_video_list /
    // factory_video_get_cost. BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md §5): the channel translations read is factory_channel_get_localizations
    // (the pattern gains channel_get; the requirement "every non-write tool is a read" is unchanged).
    // BL-220 (RESTART_WHEN_IDLE_PLAN.md): factory_restart_status is the plan's status read (the pattern gains restart_status).
    // BL-227 stage 2: + localization_requests_list (the request list is a read; claim / complete / fail are writes).
    if (!writes.has(name)) assert.match(name, /^factory_(get|list|media_(get|list|storage|capacity)|plan_(get|list|todo)|gemini_(get|list)|live_(get|list)|channel_get|storyboard_(get|list)|publishing_plan_(get|list)|localization_requests_list|jobs_list|video_(list|get_cost)|restart_status)_?/, `${name} must be a read`);
    assert.doesNotMatch(name, /_(set|issue|revoke)_|workspace|token|approve|reject/, `${name} must not touch paths, workspaces or tokens, or approve for anyone`);
  }
});

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)].map((m) => m[1]);
}

test("§2.5(3): factory-server.ts imports only the MCP SDK, zod and shared-domain -- no domain module, gateway, db or channel-scope state", async () => {
  const imports = importsOf(await readFile("src/mcp/factory-server.ts", "utf8"));
  const allowed = (spec: string) =>
    spec === "zod" || spec === "@/lib/shared-domain" || spec.startsWith("@modelcontextprotocol/sdk/");
  assert.deepEqual(imports.filter((spec) => !allowed(spec)), []);
  assert.ok(imports.length >= 3, "the scan must actually see the imports");
});

test("§2.5(3): the factory route and endpoint reach only the allowlisted modules", async () => {
  // BL-217: the channel part of the wiring moved from the route into src/mcp/factory-channel-deps.ts (shared with the channel
  // workers' versions of the channel tools); the media part stays in the route. Both files together reach only the allowlist.
  const route = importsOf(await readFile("src/app/api/mcp/factory/route.ts", "utf8"));
  // BL-218: the media part moved to src/app/api/mcp/factory-media-deps.ts (shared with the channel workers' MCP route).
  const wiring = [
    ...route,
    ...importsOf(await readFile("src/mcp/factory-channel-deps.ts", "utf8")),
    ...importsOf(await readFile("src/app/api/mcp/factory-media-deps.ts", "utf8")),
  ].filter((spec) => spec !== "./factory-server" && spec !== "../factory-media-deps");
  const routeAllowed = new Set([
    "@/lib/channel-connections",
    "@/lib/channel-workspaces",
    "@/lib/db",
    "@/lib/factory-mcp-endpoint",
    "@/lib/factory-agent-tokens",
    "@/lib/logical-paths",
    // BL-132: the media core (models, storage, templates) and the shared device mutation gate for the write tools.
    "@/lib/media-generation",
    "@/lib/device-mutation-gate",
    // BL-143 (ADR 0029): the generation plans core for the factory_plan_* tools.
    "@/lib/generation-plans",
    // BL-174 (GEMINI_MEDIA_PLAN.md §2.7): the Gemini media module for the factory_gemini_* tools.
    "@/lib/gemini-media",
    // BL-176 (LIVE_STREAMS_PLAN.md §3.11): the live-streams module for factory_live_get_status / factory_live_map_sources.
    "@/lib/live-streams",
    // BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md §5): the channel-localizations module's Operator surface (no apply) for the factory_channel_* tools.
    "@/lib/channel-localizations",
    // BL-223 (CHANNEL_BRANDING_PLAN.md §5): the channel-branding module's agent surface (no apply) for the factory_channel_*_branding tools.
    "@/lib/channel-branding",
    // BL-225 (WEEKLY_PUBLISHING_PLAN.md stage 1 item 5): the publishing-plans module's agents' surface (no decision).
    "@/lib/publishing-plans",
    // BL-225 stage 2: the composition of the plan's progress from the publishing scan (no write).
    "@/lib/publishing-plan-progress",
    // BL-227 (LANGUAGES_REVIEW_PLAN.md §5): the localization-review module's check report (it decides nothing).
    "@/lib/localization-review",
    // BL-184 (STORYBOARD_PLAN.md §2.6): the storyboards module for the factory_storyboard_* tools.
    "@/lib/storyboards",
    // BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.7): the shared jobs pool for factory_jobs_list (read-only).
    "@/lib/media-jobs-pool",
    // BL-189 (STORYBOARD_TAKES_PLAN.md §2.8): a storyboard's takes on every computer, to check factory_storyboard_attach_render's picks.
    "@/lib/storyboard-takes",
    // BL-194 (VIDEO_COST_PLAN.md §2 stage 1): the video-projects module for factory_video_create / factory_video_list.
    "@/lib/video-projects",
    // BL-194 stage 3 (VIDEO_COST_PLAN.md §2 stage 3): the video-costs module for factory_video_get_cost (loaded on use).
    "@/lib/video-costs",
    // BL-220 (RESTART_WHEN_IDLE_PLAN.md): the restart-when-idle module for the factory restart tools (holds as `factory`).
    "@/lib/restart-when-idle",
    "@/mcp/factory-server",
    "@/mcp/factory-channel-deps",
  ]);
  assert.deepEqual(wiring.filter((spec) => !routeAllowed.has(spec)), []);
  assert.ok(wiring.length >= 5);

  const endpoint = importsOf(await readFile("src/lib/factory-mcp-endpoint/index.ts", "utf8"));
  const endpointAllowed = (spec: string) =>
    spec === "@/lib/loopback-guard" || spec === "@/lib/shared-domain" || spec.startsWith("@modelcontextprotocol/sdk/");
  assert.deepEqual(endpoint.filter((spec) => !endpointAllowed(spec)), []);
});

test("§2.5(4): none of the factory files reads channel-scope state (agent-session, selected channel, credentials)", async () => {
  for (const file of ["src/mcp/factory-server.ts", "src/app/api/mcp/factory/route.ts", "src/lib/factory-mcp-endpoint/index.ts", "src/mcp/factory-channel-deps.ts", "src/app/api/mcp/factory-media-deps.ts"]) {
    const source = await readFile(file, "utf8");
    for (const forbidden of ["agent-session", "getSelectedChannelId", "resolveEffectiveCredentialRef", "credentialRef", "googleapis", "youtube-read-gateway", "youtube-write-gateway"]) {
      // Comments may mention a forbidden name; strip them before scanning.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      assert.equal(code.includes(forbidden), false, `${file} must not use ${forbidden}`);
    }
  }
});

test("AC-FO-13 / AC-FM-15: the factory API has its own version constant (1.23.0 since BL-200), separate from the channel agents' version", async () => {
  // BL-153 (FO-REQ-0008): reviewRejected, split waiting counts and overridesValidator are additive -> a minor version.
  // BL-155 (FO-REQ-0007, CUDA_HOSTS_PLAN.md "Contract"): the jobs' errorCode, the error media_gpu_host_incompatible and the
  // stopReason "all jobs failed (release when done)" are additive -> 1.7.0, as the plan states.
  // BL-157 (SERVERS_MEDIA_PLAN.md §G): the new tool factory_plan_move and the event plan_moved are additive -> 1.8.0.
  // BL-159 (PER_SESSION_CUDA_PLAN.md "Contract"): minCudaVersion on a start and a template, the host CUDA fields and the
  // early media_gpu_host_incompatible refusal are additive -> 1.9.0, as the plan states.
  // BL-172 (GPU_AVAILABILITY_PLAN.md AC-GA-08): two READ tools -> 1.10.0.
  // BL-173 (PLAN_RECHECKS_PLAN.md AC-RC-12): two WRITE tools and additive fields and events -> 1.11.0.
  // BL-174 (GEMINI_MEDIA_PLAN.md AC-GM-13): two READ tools and one WRITE tool, all new -> 1.12.0.
  // BL-175 (VISUAL_REVIEW_PLAN.md AC-VR-13): picks, marker regions, reason lists and pick targets, all additive -> 1.13.0.
  // BL-176 (LIVE_STREAMS_PLAN.md §3.11): two new tools (a read, a local write), additive -> 1.14.0.
  // BL-179 (GEMINI_OMNI_PLAN.md): a new video model and additive catalog fields -> 1.15.0.
  // BL-184 (STORYBOARD_PLAN.md §2.6): six new storyboard tools, additive -> 1.16.0.
  // BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.7): one new READ tool, factory_jobs_list, additive -> 1.17.0.
  // BL-189 (STORYBOARD_TAKES_PLAN.md §2.4): one new WRITE tool, factory_storyboard_attach_render, additive -> 1.18.0.
  // BL-194 (VIDEO_COST_PLAN.md §2 stages 1 and 3): three new tools (factory_video_create, factory_video_list, factory_video_get_cost)
  // and optional videoNumber fields, additive -> 1.20.0 (1.19.0 = BL-193).
  // BL-180 (owner msg 2902): the three Veo 3.1 previews leave the Gemini catalog (a Veo create is refused) -> 1.21.0.
  // BL-134 (FO-REQ-0028): gated Hugging Face pulls, three hf_* errors, licence fields and settings.hfToken (additive) -> 1.22.0.
  // BL-200 (FO-REQ-0029, ADR 0043): pod runtime profiles -- four tools (list, get, list ComfyUI releases, create) -> 1.23.0.
  // BL-205 (FO-REQ-0032): 1.25.0 -- factory_live_get_status gains `segments` (additive).
  // BL-206 (FO-REQ-0033, GPU_STATS_PLAN.md §2.C): 1.26.0 -- the READ tool factory_media_get_gpu_stats; the availability log stops
  // listing per-datacenter NONE rows (its summary counts stay the same).
  // BL-207 (LIVE_LOCALIZATIONS_PLAN.md §2 stage 4): 1.27.0 -- the WRITE tool factory_live_save_localizations and the additive
  // `localizations` of factory_live_get_status.
  // BL-208 (GPU_START_FIXES_PLAN.md): 1.28.0 -- factory_media_start_session answers gpuSkipped, skips carry kind, and the availability
  // log / stats read one CUDA minimum (optional minCudaVersion, echoed with the minimums present). Additive.
  // BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md §5: "This is Factory API 1.29.0"): two new tools, additive -> 1.29.0.
  // BL-220 (RESTART_WHEN_IDLE_PLAN.md "Factory API 1.30.0"): three new tools, additive -> 1.30.0.
  // BL-223 (CHANNEL_BRANDING_PLAN.md §5: "Minor version bump"): two new tools, additive -> 1.32.0.
  // BL-225 (WEEKLY_PUBLISHING_PLAN.md stage 1 item 5): three new tools, additive -> 1.33.0.
  // BL-227 (LANGUAGES_REVIEW_PLAN.md §5: "Factory API 1.34.0"): one new tool, additive -> 1.34.0.
  assert.equal(FACTORY_API_VERSION, "1.36.0"); // BL-230: factory_media_create_runtime checks github.com sources (new errors) -> 1.36.0. 1.35.0 = BL-229 part B (MUSIC_LIBRARY_PLAN.md §3): review forms, genre, answers -- additive -> 1.35.0.
  const agentOperations = await readFile("src/lib/agent-operations/contracts.ts", "utf8");
  assert.equal(agentOperations.includes("FACTORY_API_VERSION"), false);
});

// BL-206 review: the MCP boundary's copy of the stats input must not drift from the media core's schema (one accepts what the other
// refuses). Fixed inputs at and past every bound.
test("BL-206: factory_media_get_gpu_stats's MCP schema and the media core's gpuStatsInputSchema accept and refuse the same inputs", async () => {
  const { gpuStatsInput } = await import("./factory-server");
  const { gpuStatsInputSchema } = await import("@/lib/media-generation/schemas");
  const cases: Array<[unknown, boolean]> = [
    [{}, true],
    [{ from: "2026-10-19T00:00:00Z", to: "2026-10-26T00:00:00+03:00", gpuTypeIds: ["G"], dataCenterIds: ["EU-RO-1"], hoursUtc: { from: 0, to: 24 }, weekdays: [1, 7], includeSessions: true }, true],
    [{ hoursUtc: { from: 22, to: 2 } }, true],
    [{ from: "last week" }, false],
    [{ to: "2026-10-26" }, false],
    [{ gpuTypeIds: [] }, false],
    [{ gpuTypeIds: Array.from({ length: 51 }, (_, i) => `G${i}`) }, false],
    [{ dataCenterIds: ["x".repeat(33)] }, false],
    [{ hoursUtc: { from: 24, to: 24 } }, false],
    [{ hoursUtc: { from: 12, to: 25 } }, false],
    [{ hoursUtc: { from: 1, to: 0 } }, false],
    [{ hoursUtc: { from: 1, to: 5, tz: "UTC" } }, false],
    [{ weekdays: [0] }, false],
    [{ weekdays: [8] }, false],
    [{ weekdays: [1, 2, 3, 4, 5, 6, 7, 1] }, false],
    [{ includeSessions: "yes" }, false],
    [{ region: "EU" }, false],
    // BL-208 (GPU_START_FIXES_PLAN.md §F): the optional CUDA minimum of the availability read.
    [{ minCudaVersion: "13.0" }, true],
    [{ minCudaVersion: "12.8.1" }, false],
    [{ minCudaVersion: 12.8 }, false],
  ];
  for (const [input, ok] of cases) {
    assert.equal(gpuStatsInput.safeParse(input).success, ok, `MCP ${JSON.stringify(input)}`);
    assert.equal(gpuStatsInputSchema.safeParse(input).success, ok, `core ${JSON.stringify(input)}`);
  }
});
