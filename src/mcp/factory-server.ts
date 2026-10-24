/**
 * The Factory Operator's MCP server (`docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md` §2.4, slice F3).
 *
 * A server of its own, NOT a subset of `createMcpServer` (`src/mcp/server.ts`): it registers exactly the
 * tools in `FACTORY_TOOL_NAMES`, read-only, and everything it can reach arrives through the injected
 * `FactoryToolDeps` -- this file imports no domain module, no YouTube gateway, no database and no
 * channel-scope state. `src/mcp/factory-server.test.ts` fails the suite if the registered tool names
 * differ from that list, if a channel tool name is registered here, if a factory tool name is
 * classified for channel sessions, or if this file imports anything outside its allowlist.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError, isDomainError } from "@/lib/shared-domain";

/**
 * The factory API's own version (independent of the channel agents' `AGENT_API_VERSION`). 1.1.0 (BL-132, ADR 0025): the
 * media tools; 1.2.0 (BL-133, ADR 0026): GPU sessions within the owner's factory limits, jobs in them, the capacity log;
 * 1.3.0 (FO-REQ-0005): media refusals keep their codes (were `internal_error`), delete/adopt a local template, read the
 * factory settings, `targetName` on a pull -- and a pull now
 * lands under the file's base name by default (before: its repo path); files already on the volume stay where they are;
 * 1.4.0 (DEV-MSG-0001 / FO-MSG-0007): `factory_media_start_session` without `releaseWhenDone` follows the owner's setting
 * (before: false);
 * 1.5.0 (BL-143, ADR 0029): generation plans (`factory_plan_*`);
 * 1.6.0 (BL-153, FO-REQ-0008): validator-rejected attempts in the owner's review queue (`reviewRejected`);
 * 1.7.0 (BL-155, FO-REQ-0007): jobs carry `errorCode` (`media_gpu_host_incompatible` when the error says the host's CUDA driver
 * is too old), a start on incompatible hosts fails with `media_gpu_host_incompatible`, release-when-done of a session whose
 * every job failed stops with `all jobs failed (release when done)`, and the settings read shows `gpu.minCudaVersion`;
 * 1.8.0 (BL-157, FO-REQ-0009): `factory_plan_move` moves an active plan to another connected channel (its files checked in
 * that channel's Sent to YTM first, `checkOnly` to check only); the events `plan_moved` and `group_reviewed` (the owner's
 * verdicts finished a wave); the owner's wave note is `groups[].ownerNote` (the factory's stays `note`);
 * 1.9.0 (BL-159, FO-REQ-0011): `factory_media_start_session` takes `minCudaVersion` (a registry template may declare one too),
 * which may only raise the owner's setting; sessions show `minCudaVersion`, `usedMinCudaVersion` and `hostCudaVersion`, a
 * capacity-log `placed` entry shows `hostCudaVersion`, the settings read lists `gpu.cudaVersions`, and a job or plan run whose
 * template needs a newer host CUDA than the session's known host is refused with `media_gpu_host_incompatible`; a start's
 * `templateId` is looked up even when `gpu` is given (an unknown one is `media_template_not_found`); templates list `minCudaVersion`.
 */
// BL-172 (FO-REQ-0016, GPU_AVAILABILITY_PLAN.md): 1.10.0 -- the READ tools factory_media_get_gpu_availability (RunPod's GPU stock and
// price per datacenter now) and factory_media_list_gpu_availability_log (the stored 3-hourly snapshots); nothing else changes.
// BL-173 (FO-REQ-0017, PLAN_RECHECKS_PLAN.md): 1.11.0 -- the WRITE tools factory_plan_request_recheck / factory_plan_withdraw_recheck
// (a rated attempt sent back to the owner as a fixed version or a question), todo.rechecks, progress.rechecksOpen /
// groups[].counts.rechecks / rechecks[] (with currentFile), the events recheck_requested / recheck_answered / recheck_withdrawn and
// owner_verdict.recheckId; a move is refused while a re-check is open, a close withdraws them. Additive.
// BL-174 (GEMINI_MEDIA_PLAN.md §2.7): 1.12.0 -- images (Nano Banana) and video (Veo 3.1) through Google's Gemini API, paid per
// result, within the owner's limits: factory_gemini_get_status (READ), factory_gemini_create_job (WRITE; a dry-run is a read),
// factory_gemini_get_job (READ). Additive.
// BL-175 (FO-REQ-0018 §B-§D, VISUAL_REVIEW_PLAN.md §2.8): 1.13.0 -- the owner's picks ("this one of N") and "none fits" on
// image/video waves: plans/waves take reviewReasons, items pickTarget; markers take an optional region { x, y, r } (a pin);
// progress items gain pickTarget / picks / noneFits / notChosen and waves counts.picked / counts.noneFits; external attempts
// count as accepted; the events owner_pick / owner_unpick / owner_none_fits; group_reviewed counts picked and noneFits. Additive.
// BL-176 (FO-REQ-0019, LIVE_STREAMS_PLAN.md §3.4/§3.11, ADR 0036): 1.14.0 -- live streams: factory_live_get_status (READ: every
// stream on this computer and the ones other computers report, in fixed codes -- never a key, URL or error text) and
// factory_live_map_sources (WRITE, local only: which original file in the channel workspace is which published video; it only
// offers files, the owner builds the rotation and starts streams). Additive.
// BL-179 (FO-REQ-0021, GEMINI_OMNI_PLAN.md): 1.15.0 -- the video model gemini-omni-1.1-flash (text-to-video, first frame, first +
// last frame; priced by Google's token counts); the catalog's video entries gain frames, retiresOn and (Omni)
// usdPerMillionTokens; frames on a Veo model are refused before any call (gemini_invalid_params). Additive.
// BL-184 (FO-REQ-0024, STORYBOARD_PLAN.md §2.6): 1.16.0 -- storyboards reviewed before video: factory_storyboard_create /
// factory_storyboard_update / factory_storyboard_submit / factory_storyboard_reply (WRITE) and factory_storyboard_get /
// factory_storyboard_list (READ). The owner comments, requests changes and approves in the Web UI only. Additive.
// BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.7, owner msg 2806): 1.17.0 -- factory_jobs_list (READ): every computer's media jobs
// (RunPod and Gemini) in one list, with the computer and its report's age; codes only. The Operator still acts only on this
// computer's jobs. Additive.
// BL-189 (FO-REQ-0025 B, STORYBOARD_TAKES_PLAN.md §2.4): 1.18.0 -- factory_storyboard_attach_render (WRITE): the final file of the
// approved version with the take of each segment it uses, for the owner's verdict; factory_storyboard_get returns `renders`.
// Additive.
// BL-193 (ADR 0039, owner msgs 2864/2867): 1.19.0 -- the Gemini limits are shared by every computer on one Gemini key:
// factory_gemini_get_status's spend gains `account` (every computer on the key), and a create's per-day / per-month check counts the
// other computers' spend (a refusal's details gain `otherComputersUsd` when they spent something). The limits themselves are the
// same on every computer (synced). Additive in shape; a create that fitted this computer alone can now be refused.
// BL-194 stage 1 (VIDEO_COST_PLAN.md §2, ADR 0040): 1.20.0 -- video numbers from YT Manager: factory_video_create (WRITE: the next free
// Vn of a channel, local + synced) and factory_video_list (READ: every computer's numbers, the workspace's MMDD Vn folders, the
// registry and the uploads, with conflicts); an optional videoNumber on factory_media_create_job, factory_gemini_create_job,
// factory_storyboard_create / _update and factory_plan_create / _update; jobs, storyboards and plans show `video`. Stage 3:
// factory_video_get_cost (READ: one video's visual cost -- every RunPod and Gemini run on every computer). Additive.
// BL-180 (owner, Telegram msg 2902): 1.21.0 -- the three Veo 3.1 previews (veo-3.1-generate-preview, -fast-, -lite-) are removed
// from the Gemini catalog: factory_gemini_get_status no longer lists them and factory_gemini_create_job refuses them
// (gemini_invalid_params, field model). The only video model is gemini-omni-1.1-flash. Not additive: a Veo create now fails.
// BL-134 (FO-REQ-0028, ADR 0042): 1.22.0 -- factory_media_pull_model can pull from gated/private Hugging Face repos with the
// owner's read token stored on this computer (never readable through the API): new errors hf_token_missing (a gated repo, no
// token), hf_token_invalid (Hugging Face refused the token), hf_gate_not_accepted (details.repoUrl: accept the conditions there);
// a pull and factory_media_list_models show licenseId / licenseUrl from the repo card; factory_media_get_settings adds
// settings.hfToken "set" | "not set". Additive.
// BL-200 (FO-REQ-0029, ADR 0043): 1.23.0 -- pod runtime profiles: factory_media_list_runtimes / _get_runtime /
// _list_comfy_releases (READ) and factory_media_create_runtime (WRITE: a profile file on the volume; nothing built or charged);
// settings gain activeRuntimeId, factoryMayActivateRuntime, runtimeSourceAllowlist, runtimeTestMaxUsd. factory_media_start_session
// takes runtimeId? (default the active runtime; not built = media_runtime_not_ready before any pod); a session shows runtimeId and
// comfyVersion. factory_media_test_runtime (WRITE: a build if needed (cheapest GPU of the owner list), then a GPU session capped by runtimeTestMaxUsd, the node
// list against every template) and factory_media_activate_runtime (WRITE: a tested runtime, or null, while the owner's switch is
// on); a job or a factory session with templateId whose graph needs a node type the runtime's test did not find is refused with
// media_runtime_incompatible before any pod / upload. Additive (with no active runtime every session runs the built-in ComfyUI,
// as before).
// FO-REQ-0030 (BL-201): 1.24.0 -- a runtime test also checks each template's inputs against the runtime's node definitions
// (/object_info, no generation): test templates gain `invalid` [{ nodeId, classType, input, problem: required_missing |
// unknown_input | bad_value | out_of_range, allowed? }]; a template fails on any but unknown_input (a warning); media_runtime_incompatible
// also carries a template version's `invalid` from the runtime's last test. Additive in shape; a template that passed before can now
// fail its test or be refused.
// FO-REQ-0031 (same release, 1.24.0): a placed pod whose container has not started within settings.capacity.containerStartMinutes
// (default 3) is terminated then and the session is placed again up to containerStuckRetries times (default 1), else it fails with
// media_container_stuck; the capacity log gains result `container_stuck` and, on a placement that got ready, containerSeconds /
// bootSeconds; a session shows startStage (placed | pulling_image | comfy_booting | ready) and stageSince. The same limit ends a
// runtime build pod whose container does not start (built again on a new pod, same retry count).
// BL-205 (FO-REQ-0032, LIVE_SEGMENTS_PLAN.md): 1.25.0 -- factory_live_get_status gains `segments` (this computer's segment
// settings, the running segment, the last 30 days and failure stages; codes only). Additive.
// BL-206 (FO-REQ-0033, GPU_STATS_PLAN.md): 1.26.0 -- factory_media_get_gpu_stats (READ, local, no RunPod call): GPU availability
// per GPU × datacenter (snapshots, inStock, inStockShare, levels, byHourUtc, byWeekday) inside a from/to window with optional
// gpuTypeIds, dataCenterIds, hoursUtc and weekdays, and the sessions' GPU wait (median / p90 by nearest rank, failures apart,
// byCandidates, byGpu, failure reasons, the list with includeSessions); refuses from > to or a window over 90 days with
// invalid_request. The availability log is snapshotted every 15 minutes (was 3 hours; intervalHours 0.25) and stores datacenter
// rows only where the stock is not NONE -- factory_media_list_gpu_availability_log's rows no longer list per-datacenter NONE rows
// from then on (a missing row is NONE); its summary counts NONE as the GPU's snapshots − the other levels, so the numbers stay as
// before, and summary.snapshots is the snapshots taken in the range (the gpu/datacenter filters no longer narrow it). Sessions show
// firstApprovedAt, firstApprovedApproximate and gpuSkipped. Additive except the log's NONE rows.
// BL-207 (LIVE_LOCALIZATIONS_PLAN.md §2 stage 4, ADR 0045): 1.27.0 -- factory_live_save_localizations (WRITE, local only: the
// stream's translations of its title and description, one set per stream, written to every broadcast and segment after Start as
// part of the video settings; replace semantics, {} clears, any refused language refuses the whole call with every refusal in
// details.refused) and factory_live_get_status gains `localizations` (this computer only: the set, warnings and the last step, in
// codes). Additive.
// BL-208 (FO-REQ-0035, GPU_START_FIXES_PLAN.md): 1.28.0 -- factory_media_start_session's answer gains gpuSkipped [{ gpuTypeId, kind
// (stock | config), reason }] from one catalog read at start (null when it could not be read or the request is held); a start whose
// candidates were all skipped for a stock reason waits as waiting_capacity instead of failing; skip reasons name the bound
// ((Settings) / (session)); sessions' and stats' skipped entries carry kind. createPod sends RunPod's numeric gpu.minCudaVersion
// instead of the exact allowedCudaVersions list (hosts reporting CUDA 13.1/13.2 are no longer excluded). The availability log is
// snapshotted at every CUDA minimum in use (the Settings' and the installed templates'); factory_media_list_gpu_availability_log and
// factory_media_get_gpu_stats take an optional minCudaVersion (default: the Settings' minimum), read only that minimum's snapshots,
// echo it and list the minimums present in the range. Additive.
// BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md, ADR 0047): 1.29.0 -- factory_channel_save_localizations (WRITE, local only: a channel's own
// name/description translations, one set per channel, replace semantics, {} clears, any refused language refuses the whole call
// with details.refused; title 1-30 characters, description 1-1000 characters) and factory_channel_get_localizations (READ: the stored
// set, the channel's translations on YouTube read now -- 1 quota unit, no write -- and the last apply in codes). Only the owner's
// «Применить» in the Web UI sends a set to YouTube; no tool reaches it. Additive.
// BL-220 (RESTART_WHEN_IDLE_PLAN.md, ADR 0049; FO-REQ-0038): 1.30.0 -- factory_restart_status (READ: the open restart request, what
// it waits for, the holds, the last restart, the quiet minutes, whether this computer runs as the system service; this call does not
// count as MCP activity for the quiet window), factory_hold_restart (WRITE, local: keep the server from restarting for 1-60 minutes,
// with a reason) and factory_release_hold (WRITE, local: end one of the Operator's own holds; another's is not_found). Additive.
// BL-221 (CONTENT_UX_PLAN.md stage B): 1.31.0 -- factory_video_list's videos gain youtubeVideoId (the YouTube video the number became:
// the folder's Vn_youtube.json, else this computer's upload, else video_registry.csv; null while unknown) and hasVideoFile (the folder
// holds the release video file) and uploading (an upload of the number is queued or running on this computer). A Vn_youtube.json may now also be the owner's link of a video uploaded outside the app
// (result "linked", linkedBy "owner"). Additive.
export const FACTORY_API_VERSION = "1.31.0";

/** The complete, explicit allowlist of tools. A new name must be added here deliberately, with its test. */
export const FACTORY_TOOL_NAMES = [
  "factory_get_capabilities",
  "factory_list_logical_paths",
  "factory_get_logical_path",
  "factory_list_channels",
  // BL-132 (docs/roadmap/plans/FACTORY_MEDIA_CONTROL_PLAN.md §2.6): models, storage and the template registry.
  "factory_media_storage_status",
  "factory_media_list_models",
  "factory_media_pull_model",
  "factory_media_get_pull",
  "factory_media_cancel_pull",
  "factory_media_delete_model",
  "factory_media_list_templates",
  "factory_media_sync_templates",
  // FO-REQ-0005: local templates the factory may remove or take over, and a read of the owner's factory settings.
  "factory_media_delete_template",
  "factory_media_adopt_template",
  "factory_media_get_settings",
  // BL-200 (FO-REQ-0029, ADR 0043): pod runtime profiles -- ComfyUI and node packs pinned to commits, on the network volume.
  "factory_media_list_runtimes",
  "factory_media_get_runtime",
  "factory_media_list_comfy_releases",
  "factory_media_create_runtime",
  "factory_media_test_runtime",
  "factory_media_activate_runtime",
  // BL-133 (docs/roadmap/plans/FACTORY_GPU_SESSIONS_PLAN.md §2.2/§2.5): sessions it starts itself, jobs in them, the capacity log.
  "factory_media_start_session",
  "factory_media_get_session",
  "factory_media_stop_session",
  "factory_media_create_job",
  "factory_media_get_job",
  "factory_media_cancel_job",
  "factory_media_capacity_log",
  // BL-172 (FO-REQ-0016): GPU stock per datacenter, now and as stored (every 15 minutes since BL-206).
  "factory_media_get_gpu_availability",
  "factory_media_list_gpu_availability_log",
  // BL-206 (FO-REQ-0033): availability and session-wait statistics from the stored data.
  "factory_media_get_gpu_stats",
  // BL-143 (ADR 0029): generation plans.
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
  // BL-157 (FO-REQ-0009 §4): a plan moves to another channel.
  "factory_plan_move",
  // BL-173 (FO-REQ-0017): a rated attempt goes back to the owner (a fixed version or a question), and is taken back.
  "factory_plan_request_recheck",
  "factory_plan_withdraw_recheck",
  // BL-174: images and video through Google's Gemini API (no server rented; paid per result, within the owner's limits).
  "factory_gemini_get_status",
  "factory_gemini_create_job",
  "factory_gemini_get_job",
  // BL-176: live streams -- their status (read) and the map of videos to their original files (a local write).
  "factory_live_get_status",
  "factory_live_map_sources",
  // BL-207: the stream's title/description translations (a local write).
  "factory_live_save_localizations",
  // BL-210: a channel's own name/description translations -- the stored set and YouTube's (a read), saving the set (a local write).
  "factory_channel_get_localizations",
  "factory_channel_save_localizations",
  // BL-184: storyboards -- versions, submitting for the owner's review, answers to the owner's comments; reads.
  "factory_storyboard_create",
  "factory_storyboard_update",
  "factory_storyboard_get",
  "factory_storyboard_list",
  "factory_storyboard_submit",
  "factory_storyboard_reply",
  // BL-189: the final file of an approved version, for the owner's verdict.
  "factory_storyboard_attach_render",
  // BL-188: every computer's media jobs in one read-only list.
  "factory_jobs_list",
  // BL-194: video numbers -- the next free Vn of a channel, and the channel's videos; stage 3: a video's visual cost.
  "factory_video_create",
  "factory_video_list",
  "factory_video_get_cost",
  // BL-220: restart when idle -- the status (a read), holding the restart and ending the Operator's own hold (local writes).
  "factory_restart_status",
  "factory_hold_restart",
  "factory_release_hold",
] as const;

/**
 * The tools that change something (owner decision D1: no second approval in the Web UI; each is audited with the actor
 * `factory` and passes the device mutation gate first). Everything else in the list is a read. No tool sets a logical
 * path, a workspace or a token. Since BL-133 (ADR 0026) the factory starts GPU sessions -- approved by itself ONLY within
 * the owner's factory limits, otherwise left pending for the owner -- and runs jobs in the sessions it started.
 */
export const FACTORY_WRITE_TOOL_NAMES = [
  "factory_media_pull_model",
  "factory_media_cancel_pull",
  "factory_media_delete_model",
  "factory_media_sync_templates",
  "factory_media_delete_template",
  "factory_media_adopt_template",
  // BL-200: a new runtime profile (a file on the volume; nothing is built, started or charged), its test (a build and a
  // short GPU session, within the owner's limits) and making it active (only with the owner's switch on).
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
  // BL-157 (FO-REQ-0009 §4): a plan moves to another channel.
  "factory_plan_move",
  // BL-173 (FO-REQ-0017): re-checks of rated attempts.
  "factory_plan_request_recheck",
  "factory_plan_withdraw_recheck",
  // BL-174: a paid Gemini job (only within the owner's limits; a dry-run passes no gate).
  "factory_gemini_create_job",
  // BL-176: the map of videos to original files (local only; nothing reaches YouTube, nothing starts a stream).
  "factory_live_map_sources",
  // BL-207: the stream's translations (local only; written to YouTube only by the app after the owner's Start).
  "factory_live_save_localizations",
  // BL-210: a channel's translations (local only; written to YouTube only by the owner's «Применить» in the Web UI).
  "factory_channel_save_localizations",
  // BL-184: storyboard versions, submissions and answers (synced to the other computers; nothing is generated or charged).
  "factory_storyboard_create",
  "factory_storyboard_update",
  "factory_storyboard_submit",
  "factory_storyboard_reply",
  // BL-189: the Operator's final file of an approved version (a record; nothing is generated or charged).
  "factory_storyboard_attach_render",
  // BL-194: reserves the next video number of a channel (local and synced; nothing is generated, charged or sent to YouTube).
  "factory_video_create",
  // BL-220: a restart hold and its release (local only; they keep this computer's server from restarting, nothing else).
  "factory_hold_restart",
  "factory_release_hold",
] as const;

/** BL-220: a status poll must not keep the quiet window open forever, so it is not counted as an MCP call (`mcp_tool_calls`). */
const UNCOUNTED_TOOLS: ReadonlySet<string> = new Set(["factory_restart_status"]);

export type FactoryChannelEntry = {
  channelId: string;
  title: string;
  /** This device's production-workspace path for the channel, or `configured:false`. */
  workspace: { configured: false } | { configured: true; path: string };
};

/** Everything the factory tools can reach. Wired in `src/app/api/mcp/factory/route.ts`, its channel part in `src/mcp/factory-channel-deps.ts` (BL-217; also used, channel-pinned, by the workers). */
export type FactoryToolDeps = {
  readLogicalPath(input: unknown): Promise<{ name: string; path: string }>;
  listLogicalPaths(): Promise<
    Array<{ name: string; description: string; configured: false } | { name: string; description: string; configured: true; path: string }>
  >;
  listChannels(): Promise<FactoryChannelEntry[]>;
  /** Counts a real tool invocation for the Settings traffic stats (`mcp_tool_calls`). */
  recordOutcome(outcome: "allowed" | "blocked"): Promise<void>;
  /** BL-132: the media core's factory-facing actions (wired in the route; every write is recorded with actor `factory`). */
  media: {
    storageStatus(): Promise<Record<string, unknown>>;
    listModels(): Promise<Record<string, unknown>>;
    pullModel(input: { repoId: string; file: string; folder: string; revision?: string; sha256: string; targetName?: string }): Promise<Record<string, unknown>>;
    getPull(input: { pullId?: string }): Promise<Record<string, unknown>>;
    cancelPull(input: { pullId: string }): Promise<Record<string, unknown>>;
    deleteModel(input: { key: string }): Promise<Record<string, unknown>>;
    listTemplates(): Promise<Record<string, unknown>>;
    syncTemplates(input: { dryRun: boolean }): Promise<Record<string, unknown>>;
    // FO-REQ-0005.
    deleteTemplate(input: { templateId: string }): Promise<Record<string, unknown>>;
    adoptTemplate(input: { templateId: string; newTemplateId: string }): Promise<Record<string, unknown>>;
    getSettings(): Promise<Record<string, unknown>>;
    // BL-200.
    listRuntimes(): Promise<Record<string, unknown>>;
    getRuntime(input: { runtimeId: string }): Promise<Record<string, unknown>>;
    listComfyReleases(): Promise<Record<string, unknown>>;
    createRuntime(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    testRuntime(input: { runtimeId: string; templateIds?: string[]; channelId?: string }): Promise<Record<string, unknown>>;
    setActiveRuntime(input: { runtimeId: string | null }): Promise<Record<string, unknown>>;
    // BL-133.
    startSession(input: { channelId: string; maxMinutes?: number; maxUsd?: number; templateId?: string; gpu?: { candidates: string[]; minVramGb?: number | null; maxPricePerHr?: number | null }; releaseWhenDone?: boolean; planId?: string; minCudaVersion?: string; runtimeId?: string | null }): Promise<Record<string, unknown>>;
    /** BL-218 review: `channelId` (a worker's pinned call only; not in the factory tool's input) filters before the 20-row cut. */
    getSession(input: { sessionId?: string; channelId?: string }): Promise<Record<string, unknown>>;
    endSession(input: { sessionId: string }): Promise<Record<string, unknown>>;
    createJob(input: { sessionId: string; templateId: string; params: Record<string, string | number | boolean>; planId?: string; itemKey?: string; seed?: number; storyboardId?: string; segmentId?: string; videoNumber?: string }): Promise<Record<string, unknown>>;
    getJob(input: { jobId?: string; sessionId?: string }): Promise<Record<string, unknown>>;
    cancelJob(input: { jobId: string }): Promise<Record<string, unknown>>;
    capacityLog(input: { since?: string; gpuTypeId?: string; limit?: number }): Promise<Record<string, unknown>>;
    // BL-172 (FO-REQ-0016 A).
    gpuAvailability(input: { gpuTypeIds?: string[]; dataCenterIds?: string[]; minVramGb?: number; minCudaVersion?: string }): Promise<Record<string, unknown>>;
    gpuAvailabilityLog(input: { since?: string; until?: string; gpuTypeId?: string; dataCenterId?: string; limit?: number; summary?: boolean; minCudaVersion?: string }): Promise<Record<string, unknown>>;
    // BL-206 (FO-REQ-0033).
    gpuStats(input: { from?: string; to?: string; gpuTypeIds?: string[]; dataCenterIds?: string[]; hoursUtc?: { from: number; to: number }; weekdays?: number[]; includeSessions?: boolean; minCudaVersion?: string }): Promise<Record<string, unknown>>;
  };
  /** BL-143 (ADR 0029): the generation plans core; it validates every input strictly itself. */
  plans: {
    create(input: unknown): Promise<Record<string, unknown>>;
    importPlan(input: unknown): Promise<Record<string, unknown>>;
    update(input: unknown): Promise<Record<string, unknown>>;
    close(input: unknown): Promise<Record<string, unknown>>;
    get(input: unknown): Promise<Record<string, unknown>>;
    list(input: unknown): Promise<Record<string, unknown>>;
    todo(input: unknown): Promise<Record<string, unknown>>;
    report(input: unknown): Promise<Record<string, unknown>>;
    runStage(input: unknown): Promise<Record<string, unknown>>;
    rerun(input: unknown): Promise<Record<string, unknown>>;
    cloneGroup(input: unknown): Promise<Record<string, unknown>>;
    move(input: unknown): Promise<Record<string, unknown>>;
    /** BL-173: open a re-check of a rated attempt; withdraw an open one. */
    requestRecheck(input: unknown): Promise<Record<string, unknown>>;
    withdrawRecheck(input: unknown): Promise<Record<string, unknown>>;
  };
  /** BL-174: the Gemini media module (it validates every input strictly itself, and enforces the owner's switch and limits). */
  gemini: {
    getStatus(): Promise<Record<string, unknown>>;
    createJob(input: unknown): Promise<Record<string, unknown>>;
    getJobs(input: unknown): Promise<Record<string, unknown>>;
  };
  /** BL-176: live streams (the module validates every input strictly itself). */
  live: {
    getStatus(input: { channelId?: string }): Promise<Record<string, unknown>>;
    mapSources(input: { channelId: string; items: Array<{ videoId: string; file: string }> }): Promise<Record<string, unknown>>;
    /** BL-207: replace the stream's translations (the module validates every language; nothing is half-saved). */
    setLocalizations(input: { channelId: string; localizations: Record<string, { title: string; description: string }> }): Promise<Record<string, unknown>>;
  };
  /**
   * BL-210: a channel's own translations (the channel-localizations module validates every language itself). Its Operator surface
   * has no apply: nothing here reaches a YouTube write.
   */
  channelLocalizations: {
    get(input: { channelId: string }): Promise<Record<string, unknown>>;
    save(input: { channelId: string; localizations: Record<string, { title: string; description: string }> }): Promise<Record<string, unknown>>;
  };
  /** BL-184: storyboards (the module validates every input strictly itself; every write is the Operator's). */
  storyboards: {
    create(input: unknown): Promise<Record<string, unknown>>;
    update(input: unknown): Promise<Record<string, unknown>>;
    get(input: unknown): Promise<Record<string, unknown>>;
    list(input: unknown): Promise<Record<string, unknown>>;
    submit(input: unknown): Promise<Record<string, unknown>>;
    reply(input: unknown): Promise<Record<string, unknown>>;
    /** BL-189: the final file of the approved version (the route checks each pick against the takes on every computer). */
    attachRender(input: unknown): Promise<Record<string, unknown>>;
  };
  /** BL-194 (ADR 0040): video numbers (the video-projects module validates every input strictly itself). */
  videos: {
    create(input: unknown): Promise<Record<string, unknown>>;
    list(input: unknown): Promise<Record<string, unknown>>;
    /** BL-194 stage 3 (ADR 0041): one video's visual cost on every computer (the video-costs module validates strictly itself). */
    cost(input: unknown): Promise<Record<string, unknown>>;
  };
  /** BL-188: every computer's media jobs, read-only (the pool module filters and bounds them). */
  jobs: {
    list(input: { channelId?: string; source?: "runpod" | "gemini"; mediaKind?: "audio" | "image" | "video"; status?: string; planId?: string; limit?: number }): Promise<Record<string, unknown>>;
  };
  /** BL-220 (ADR 0049): restart when idle, with the Operator as the hold owner `factory` (the module validates every input itself). */
  restart: {
    status(): Promise<Record<string, unknown>>;
    hold(input: { minutes: unknown; reason: unknown }): Promise<Record<string, unknown>>;
    release(input: { holdId: unknown }): Promise<Record<string, unknown>>;
  };
  /** The same local gate every mutating channel tool passes (operation lock, recovery mode); throws when not allowed. */
  assertMutationAllowed(): Promise<void>;
};

export type FactoryToolContract = { description: string; inputSchema: z.ZodTypeAny };

export type FactoryServerOptions = {
  /** The verified session of THIS request. Absent means "no valid token": ZERO tools are registered. */
  session?: { tokenId: string; reverify(): Promise<void> } | null;
  connectionEnabled?: boolean;
  /**
   * BL-217 (WORKER_CAPABILITIES_PLAN.md stage 3): instead of registering the tools, hand each one's contract and handler to the
   * caller -- the channel workers' MCP server re-exposes a closed subset under `agent_*` names, with channel-pinned `deps`. The
   * handler is the tool's own (input checks, errors as `{ ok: false, error }`), without this server's token re-check and call
   * counting: the caller's own session wrapper does both. Nothing is registered on this server then.
   */
  collect?: (name: (typeof FACTORY_TOOL_NAMES)[number], contract: FactoryToolContract, handler: (args: unknown) => Promise<ToolResponse>) => void;
};

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function successResult(payload: Record<string, unknown>): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

/**
 * FO-REQ-0005 item 1: the device mutation gate every write tool passes first throws `OperationLockError` /
 * `RecoveryModeError` -- deliberately not DomainErrors (`src/mcp/server.ts` maps the same two). This file may not import
 * them (§2.5(3) allowlist), so they are recognised by exactly their two documented codes on an `Error` -- never "any
 * object with a string code", which would also echo a raw driver error (SQLITE_BUSY) as if it were a stable code.
 */
const MUTATION_GATE_CODES = new Set(["operation_lock_held", "device_in_recovery_mode"]);

function mutationGateShape(error: unknown): { code: string; message: string; details: unknown } | null {
  if (!(error instanceof Error)) return null;
  const { code, details } = error as Error & { code?: unknown; details?: unknown };
  return typeof code === "string" && MUTATION_GATE_CODES.has(code) ? { code, message: error.message, details } : null;
}

function errorResult(error: unknown, toolName?: string): ToolResponse {
  // `isDomainError`, never `instanceof` (FO-REQ-0005 item 1, the real cause; same fix as 23cab7d for src/mcp/server.ts):
  // the media core lives on globalThis and is first built by the instrumentation bundle, so its errors are another
  // bundle's DomainError class -- `instanceof` failed and every media refusal came back as `internal_error`.
  const known = isDomainError(error) ? { code: error.code, message: error.message, details: error.details } : mutationGateShape(error);
  // An unexpected error is still reported to the role only as `internal_error`, but logged here so it can be diagnosed
  // (FO-REQ-0005: one such answer left no trace at all).
  if (!known) console.error(`[factory-mcp] ${toolName ?? "tool"} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  const shape = known ?? { code: "internal_error", message: "internal error" };
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: shape }) }], isError: true };
}

const emptyInput = z.object({}).strict();
const getLogicalPathInput = z.object({ name: z.string().min(1).max(64) }).strict();
// BL-132 inputs. The media core validates them again (repo id, folder, path safety); these keep the contract explicit.
const pullModelInput = z
  .object({
    repoId: z.string().min(3).max(200),
    file: z.string().min(1).max(500),
    folder: z.string().min(1).max(64),
    revision: z.string().min(1).max(200).optional(),
    /** FO-REQ-0005: the file name under models/<folder>/ (default: the base name of `file`). */
    targetName: z.string().min(1).max(200).optional(),
    /** Required here (owner decision D2): the request carries the expected hash. */
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, "64 hex characters"),
  })
  .strict();
const pullIdInput = z.object({ pullId: z.string().min(1).max(64) }).strict();
const optionalPullIdInput = z.object({ pullId: z.string().min(1).max(64).optional() }).strict();
// BL-200: the shapes only; the media core validates every field strictly (allow-list, commits, pins).
const runtimeIdInput = z.object({ runtimeId: z.string().min(1).max(64) }).strict();
const createRuntimeInput = z
  .object({
    runtimeId: z.string().min(1).max(64),
    name: z.string().max(120).optional(),
    description: z.string().max(1000).optional(),
    comfy: z.object({ repo: z.string().max(300).optional(), ref: z.string().min(1).max(200) }).strict(),
    customNodes: z.array(z.object({ repo: z.string().max(300), commit: z.string().max(64) }).strict()).max(50).optional(),
    pip: z.array(z.string().max(200)).max(100).optional(),
  })
  .strict();
const testRuntimeInput = z
  .object({
    runtimeId: z.string().min(1).max(64),
    templateIds: z.array(z.string().min(1).max(64)).max(200).optional(),
    channelId: z.string().min(1).max(64).optional(),
  })
  .strict();
const setActiveRuntimeInput = z.object({ runtimeId: z.string().min(1).max(64).nullable() }).strict();
const modelKeyInput = z.object({ key: z.string().min(1).max(1000) }).strict();
const syncInput = z.object({ dryRun: z.boolean().optional() }).strict();
const templateIdInput = z.object({ templateId: z.string().min(1).max(64) }).strict();
const adoptTemplateInput = z.object({ templateId: z.string().min(1).max(64), newTemplateId: z.string().min(2).max(63) }).strict();
// BL-133 inputs (the media core validates again).
const gpuPlanInput = z
  .object({
    candidates: z.array(z.string().min(1).max(128)).min(1).max(10),
    minVramGb: z.number().int().min(1).max(1024).nullable().optional(),
    maxPricePerHr: z.number().gt(0).max(1000).nullable().optional(),
  })
  .strict();
const startSessionInput = z
  .object({
    channelId: z.string().min(1).max(64),
    maxMinutes: z.number().int().min(1).max(1440).optional(),
    maxUsd: z.number().gt(0).max(10_000).optional(),
    templateId: z.string().min(1).max(64).optional(),
    gpu: gpuPlanInput.optional(),
    releaseWhenDone: z.boolean().optional(),
    /** BL-143: the generation plan this session works for (its whole cost counts there). */
    planId: z.string().min(2).max(80).optional(),
    /** BL-159: the session's own minimum host CUDA version (only raises the owner's setting). The shape is checked here; the
     * media core accepts only the versions RunPod knows (gpu.cudaVersions). */
    minCudaVersion: z.string().regex(/^\d{1,2}\.\d{1,2}$/).optional(),
    /** BL-200 (1.23.0): the pod runtime profile to run; absent = the active one, null = the image's built-in ComfyUI. */
    runtimeId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/).nullable().optional(),
  })
  .strict();
const sessionIdInput = z.object({ sessionId: z.string().min(1).max(64) }).strict();
const optionalSessionIdInput = z.object({ sessionId: z.string().min(1).max(64).optional() }).strict();
const createJobInput = z
  .object({
    sessionId: z.string().min(1).max(64),
    templateId: z.string().min(1).max(64),
    params: z.record(z.string().min(1).max(64), z.union([z.string().max(20_000), z.number(), z.boolean()])).default({}),
    /** BL-143: the plan attempt this job is (all three, or none). */
    planId: z.string().min(2).max(80).optional(),
    itemKey: z.string().min(1).max(120).optional(),
    seed: z.number().int().min(0).optional(),
    /** BL-184 stage 2: the storyboard segment this video renders (both, or neither). */
    storyboardId: z.string().min(1).max(40).optional(),
    segmentId: z.string().min(1).max(40).optional(),
    /** BL-194: the channel's video number this job is for (omitted: its storyboard's, else its plan's). */
    videoNumber: z.string().min(1).max(12).optional(),
  })
  .strict();
const getJobInput = z.object({ jobId: z.string().min(1).max(64).optional(), sessionId: z.string().min(1).max(64).optional() }).strict();
const jobIdInput = z.object({ jobId: z.string().min(1).max(64) }).strict();
const capacityLogInput = z
  .object({ since: z.string().datetime().optional(), gpuTypeId: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(500).optional() })
  .strict();
// BL-172: the shape only; the media core checks the CUDA version against its own list.
const gpuAvailabilityInput = z
  .object({
    gpuTypeIds: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
    dataCenterIds: z.array(z.string().min(1).max(32)).min(1).max(50).optional(),
    minVramGb: z.number().int().min(0).max(1024).optional(),
    minCudaVersion: z.string().regex(/^\d{1,2}\.\d$/, "a CUDA version such as 12.8").optional(),
  })
  .strict();
const gpuAvailabilityLogInput = z
  .object({
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    gpuTypeId: z.string().min(1).max(128).optional(),
    dataCenterId: z.string().min(1).max(32).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    summary: z.boolean().optional(),
    /** BL-208 (1.28.0): the CUDA minimum whose snapshots are read; the media core accepts only gpu.cudaVersions. */
    minCudaVersion: z.string().regex(/^\d{1,2}\.\d$/, "a CUDA version such as 12.8").optional(),
  })
  .strict();

// BL-206: the boundary copy of the media core's `gpuStatsInputSchema` (media-generation/schemas.ts) -- this file may import no domain
// module (§2.5(3)), so the shape is repeated here, as for the other factory tools, and factory-server.test.ts checks that both accept
// and refuse exactly the same inputs. The core also checks that from/to fit together (invalid_request).
export const gpuStatsInput = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    gpuTypeIds: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
    dataCenterIds: z.array(z.string().min(1).max(32)).min(1).max(50).optional(),
    hoursUtc: z.object({ from: z.number().int().min(0).max(23), to: z.number().int().min(1).max(24) }).strict().optional(),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    includeSessions: z.boolean().optional(),
    /** BL-208 (1.28.0): the CUDA minimum whose availability snapshots are counted; the media core accepts only gpu.cudaVersions. */
    minCudaVersion: z.string().regex(/^\d{1,2}\.\d$/, "a CUDA version such as 12.8").optional(),
  })
  .strict();

function parseInput<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new DomainError({
      code: "validation_failed",
      message: "Invalid MCP tool input",
      details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message, code: issue.code })),
    });
  }
  return parsed.data;
}

export function createFactoryMcpServer(deps: FactoryToolDeps, options: FactoryServerOptions = {}) {
  const connectionEnabled = options.connectionEnabled ?? true;
  const session = options.session ?? null;

  const server = new McpServer({ name: "youtube-operations-manager-factory", version: FACTORY_API_VERSION });

  function registerTool(
    name: (typeof FACTORY_TOOL_NAMES)[number],
    config: { description: string; inputSchema: z.ZodTypeAny },
    handler: (args: unknown) => Promise<ToolResponse>
  ) {
    if (options.collect) {
      options.collect(name, config, async (args: unknown) => {
        try {
          return await handler(args);
        } catch (error) {
          return errorResult(error, name);
        }
      });
      return;
    }
    if (!connectionEnabled || !session) return;
    const counted = async (args: unknown): Promise<ToolResponse> => {
      try {
        await session.reverify();
      } catch (error) {
        await deps.recordOutcome("blocked");
        // Only a real "token not accepted" is reported as an invalid token. A database failure while re-verifying must not
        // tell the role its (perfectly good) token was revoked (same rule as the endpoint's own 503).
        return errorResult(isDomainError(error) && error.code === "AGENT_TOKEN_INVALID" ? error : new Error("token verification unavailable"));
      }
      if (!UNCOUNTED_TOOLS.has(name)) await deps.recordOutcome("allowed");
      try {
        return await handler(args);
      } catch (error) {
        return errorResult(error, name);
      }
    };
    server.registerTool(name, config as never, counted as never);
  }

  registerTool(
    "factory_get_capabilities",
    {
      description:
        "Report this endpoint's factory API version, the tools actually callable by the Factory Operator role, the permissions this token holds (READ and WRITE) and which tools write. Call this first. A local read; no channel scoping, no YouTube call.",
      inputSchema: emptyInput,
    },
    async () =>
      successResult({
        role: "factory_operator",
        factoryApiVersion: FACTORY_API_VERSION,
        tools: [...FACTORY_TOOL_NAMES],
        permissions: ["READ", "WRITE"],
        writeTools: [...FACTORY_WRITE_TOOL_NAMES],
      })
  );

  registerTool(
    "factory_list_logical_paths",
    {
      description:
        "List every logical path defined in this app with THIS computer's value: { name, description, configured, path }. configured:false means no folder is set on this computer (never an empty path). Paths are text only: this app never opens or lists anything inside a folder. Read-only.",
      inputSchema: emptyInput,
    },
    async () => successResult({ paths: await deps.listLogicalPaths() })
  );

  registerTool(
    "factory_get_logical_path",
    {
      description:
        "Get one logical path's value on THIS computer by name. Fails with LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE when the path exists but no folder is set on this computer (never returns an empty path), and with LOGICAL_PATH_NOT_FOUND for an unknown name. Read-only: a path can only be set by the operator in the app's Settings.",
      inputSchema: getLogicalPathInput,
    },
    async (args) => {
      const parsed = getLogicalPathInput.safeParse(args);
      if (!parsed.success) {
        throw new DomainError({
          code: "validation_failed",
          message: "Invalid MCP tool input",
          details: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message, code: issue.code })),
        });
      }
      return successResult(await deps.readLogicalPath(parsed.data));
    }
  );

  registerTool(
    "factory_list_channels",
    {
      description:
        "List the channels connected to this app: { channelId, title, workspace } where workspace is this computer's production-workspace folder path for the channel or { configured:false }. Contains no credentials, account identities, videos or analytics. Read-only.",
      inputSchema: emptyInput,
    },
    async () => successResult({ channels: await deps.listChannels() })
  );

  // -- BL-132: media models, storage and the template registry (FACTORY_MEDIA_CONTROL_PLAN.md §2.6) ------------------

  registerTool(
    "factory_media_storage_status",
    {
      description:
        "The RunPod network volume that holds the media models: { storage: { volumeId, dataCenterId, sizeGb, usedGb, freeGb, monthlyUsd } } as RunPod reports it (RunPod bills the rented size). Read-only; one RunPod API call.",
      inputSchema: emptyInput,
    },
    async () => successResult(await deps.media.storageStatus())
  );

  // BL-200 (FO-REQ-0029, ADR 0043): pod runtime profiles.
  registerTool(
    "factory_media_list_runtimes",
    {
      description:
        "List the pod runtime profiles on the network volume (1.23.0): { runtimes: [{ runtimeId, name, comfy: { repo, commit, ref }, customNodes: [{ repo, commit }], pip, createdAt, createdBy, status: created | building | build_failed | built | test_failed | tested, active, ready (the build's .ready marker on the volume -- without it the runtime is not built), build, test: { ok, testedAt, comfyVersion, nodeCount, templates, costUsd, bootSeconds } }], activeRuntimeId }. activeRuntimeId null = the image's built-in ComfyUI. Read-only.",
      inputSchema: emptyInput,
    },
    async () => successResult(await deps.media.listRuntimes())
  );

  registerTool(
    "factory_media_get_runtime",
    {
      description:
        "One runtime profile with its test result per template ({ runtime: { ...profile, templates: [{ templateId, version, ok, missing: [node types], invalid: [{ nodeId, classType, input, problem, allowed? }] (1.24.0) }] }, builds: [its builds on this computer: status running | built | failed | timeout, error], tests: [its tests: status building | starting | passed | failed, sessionId, error, costUsd, bootSeconds] }). Read-only.",
      inputSchema: runtimeIdInput,
    },
    async (args) => successResult(await deps.media.getRuntime(parseInput(runtimeIdInput, args)))
  );

  registerTool(
    "factory_media_list_comfy_releases",
    {
      description: "ComfyUI's newest releases on GitHub ({ repo, releases: [{ tag, name, publishedAt, prerelease }] }), for choosing comfy.ref. Read-only.",
      inputSchema: emptyInput,
    },
    async () => successResult(await deps.media.listComfyReleases())
  );

  registerTool(
    "factory_media_create_runtime",
    {
      description:
        "Create a pod runtime profile (1.23.0): { runtimeId (3-63 lower-case letters, digits, '-'), name?, description?, comfy: { repo? (default https://github.com/comfyanonymous/ComfyUI), ref (a tag or branch, resolved to its exact commit now, or an exact 40-hex commit) }, customNodes?: [{ repo, commit (exactly 40 hex) }], pip?: ['name==version'; torch, torchvision and torchaudio come from the pod image and cannot be pinned] }; two node packs may not share a folder (repository) name. Every repository must be HTTPS and under the owner's allowed sources (Servers → Setup; settings.runtimeSourceAllowlist in factory_media_get_settings), otherwise validation_failed lists the refused ones. A profile is never edited: the same runtimeId twice is refused -- create a new one. Nothing is built, started or charged here. Recorded as created by the Factory Operator.",
      inputSchema: createRuntimeInput,
    },
    async (args) => {
      const input = parseInput(createRuntimeInput, args);
      await deps.assertMutationAllowed();
      return successResult({ runtime: await deps.media.createRuntime(input) });
    }
  );

  registerTool(
    "factory_media_test_runtime",
    {
      description:
        "Test a pod runtime profile (1.23.0; input check 1.24.0): { runtimeId, templateIds? (default: every registry template), channelId? (the connected channel the test session is booked to; default: the first connected one) }. Returns at once with { test: { testId, status: building | starting | passed | failed, ... } }; the server advances it about once a minute -- poll factory_media_get_runtime (its `tests`). Steps: a runtime that is not built is built first on a pod of the cheapest GPU of the owner's list in the volume's datacenter (~10 min, about $0.05-0.15; the GPU is not used); then a short GPU session on the runtime under YOUR factory limits, its USD cap = the owner's runtimeTestMaxUsd ($0.5 by default) and its minutes what that buys at the GPU's price (3-15 min); once ComfyUI answers, its node types (/object_info) and version (/system_stats) are read, every template's graph is checked for node types the runtime lacks and (1.24.0) for inputs its nodes do not accept -- a required input not set (by value, link or a template parameter), a list value not allowed, a number out of range or of the wrong type; an input the node does not declare is only a warning -- the session is stopped, and the result is kept beside the profile (factory_media_get_runtime: templates [{ templateId, version, ok, missing, invalid }], comfyVersion, costUsd, bootSeconds). The test passes when every checked template has all its nodes and no blocking input problem (anything but unknown_input). No generation is run. A session held by a limit fails the test (nothing is billed).",
      inputSchema: testRuntimeInput,
    },
    async (args) => {
      const input = parseInput(testRuntimeInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.testRuntime(input));
    }
  );

  registerTool(
    "factory_media_activate_runtime",
    {
      description:
        "Make a pod runtime the default for new sessions (1.23.0): { runtimeId } -- only a runtime whose test against EVERY registry template passed (status tested, a test without templateIds; otherwise media_runtime_not_ready), and only while the owner's switch 'The Operator may make a runtime active' is on (settings.factoryMayActivateRuntime; off = media_runtime_activation_disabled -- you can still create and test). { runtimeId: null } = the image's built-in ComfyUI. Rollback = set the previous runtimeId (returned as previousRuntimeId). Sessions already running keep their runtime. Recorded with who and when.",
      inputSchema: setActiveRuntimeInput,
    },
    async (args) => {
      const input = parseInput(setActiveRuntimeInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.setActiveRuntime(input));
    }
  );

  registerTool(
    "factory_media_list_models",
    {
      description:
        "List the model files on the network volume: { models: [{ key, folder, name, bytes, lastModified, sha256, usedBy: [{ templateId, version, source }] }], registry, registryError }. sha256 is the hash verified by a pull on this computer (null if unknown). usedBy includes local (owner-imported) templates (source 'owner'). Read-only.",
      inputSchema: emptyInput,
    },
    async () => successResult(await deps.media.listModels())
  );

  registerTool(
    "factory_media_pull_model",
    {
      description:
        "Put one model file from a Hugging Face repository on the network volume (public, or gated/private when the owner stored a read token on this computer and accepted the repo's conditions -- 1.22.0): { repoId, file, folder, revision?, sha256, targetName? }. sha256 is REQUIRED. The file lands at models/<folder>/<targetName>; targetName defaults to the base name of file (the repo's sub-folders are dropped: file 'split_files/vae/x.safetensors' with folder 'vae' -> models/vae/x.safetensors). Give targetName (one file name: letters, digits, '.', '_', '+', '-') when that key is taken, e.g. two repos' model.safetensors. Before any pod starts the file is checked on Hugging Face (exists, readable -- a gated repo without a token is hf_token_missing, a refused token hf_token_invalid, conditions not accepted hf_gate_not_accepted with details.repoUrl --, its declared SHA-256 equals yours, fits in the free space); then a small CPU pod downloads that exact commit, hashes it and moves it into place only if the hash matches (otherwise nothing is left). Refused while GPU sessions use the volume (media_session_conflict) or another pull runs; an existing file is never overwritten. Returns { pull } with expectedBytes and licenseId / licenseUrl from the repo card; track it with factory_media_get_pull. The token is never shown. Costs a few cents of CPU time plus storage. Recorded as requested by the Factory Operator.",
      inputSchema: pullModelInput,
    },
    async (args) => {
      const input = parseInput(pullModelInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.pullModel(input));
    }
  );

  registerTool(
    "factory_media_get_pull",
    {
      description:
        "One model pull by pullId ({ pull }), or the recent pulls ({ pulls }) without it. A pull is running, done (sha256 verified), failed (with the reason, e.g. a hash mismatch) or timeout. Read-only.",
      inputSchema: optionalPullIdInput,
    },
    async (args) => successResult(await deps.media.getPull(parseInput(optionalPullIdInput, args)))
  );

  registerTool(
    "factory_media_cancel_pull",
    {
      description: "Cancel a running model pull: { pullId }. Its pod is terminated and nothing is left under models/. Recorded as done by the Factory Operator.",
      inputSchema: pullIdInput,
    },
    async (args) => {
      const input = parseInput(pullIdInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.cancelPull(input));
    }
  );

  registerTool(
    "factory_media_delete_model",
    {
      description:
        "Delete one model file from the network volume: { key } (a models/ key from factory_media_list_models). Refused with media_model_in_use while any template uses it (registry, installed or local), with media_template_registry_unavailable when the template registry cannot be read on this computer, and while sessions or a pull use the volume. There is no undo except pulling it again. Recorded as done by the Factory Operator.",
      inputSchema: modelKeyInput,
    },
    async (args) => {
      const input = parseInput(modelKeyInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.deleteModel(input));
    }
  );

  registerTool(
    "factory_media_list_templates",
    {
      description:
        "List this computer's media workflow templates: { templates: [{ templateId, version, source ('factory' from the registry, 'owner' = local), name, description, parameters, models, modelsMissing, minCudaVersion (1.9.0: the lowest host CUDA the template needs, null = none), updatedAt }], lastSync }. modelsMissing = declared models not on the volume (null when the volume could not be listed). Read-only.",
      inputSchema: emptyInput,
    },
    async () => successResult(await deps.media.listTemplates())
  );

  registerTool(
    "factory_media_sync_templates",
    {
      description:
        "Sync this computer's factory templates from the template registry folder (logical path media_templates): { dryRun? }. Returns { result: { outcome, installed, updated, removed, unchanged, pending, invalid } }. A lower version, or the same version with other content, is refused; an unreadable index changes nothing; a listed file not there yet is pending; local templates are never touched, except one you adopted (factory_media_adopt_template), which is removed once its registry template is installed. The app also checks the registry by itself every minute. Recorded as done by the Factory Operator.",
      inputSchema: syncInput,
    },
    async (args) => {
      const input = parseInput(syncInput, args);
      if (!input.dryRun) await deps.assertMutationAllowed();
      return successResult(await deps.media.syncTemplates({ dryRun: input.dryRun ?? false }));
    }
  );

  // -- FO-REQ-0005: local (owner-imported) templates, and the owner's factory settings ----------------------------------

  registerTool(
    "factory_media_delete_template",
    {
      description:
        "Delete one LOCAL (owner-imported, source 'owner') workflow template from this computer: { templateId } -> { deleted: true }. Agree it with the owner in chat first; there is no second approval and no undo. A registry template (source 'factory') is refused (media_template_invalid): remove it from the registry index instead. Unknown id -> media_template_not_found. Its models are then no longer 'usedBy' it. Recorded as done by the Factory Operator (Web UI: Servers → Models, recent actions).",
      inputSchema: templateIdInput,
    },
    async (args) => {
      const input = parseInput(templateIdInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.deleteTemplate(input));
    }
  );

  registerTool(
    "factory_media_adopt_template",
    {
      description:
        "Take a LOCAL template over into the template registry: { templateId (the local one), newTemplateId (registry id: 2-63 lower-case letters, digits, '-') } -> { localTemplateId, templateId, fileName, indexEntry, template, status }. Nothing is written to the registry by the app: write `template` exactly as <registry>/<fileName> (version 1; models declared from the graph's loader nodes, sha256 not set -- add it if you want it checked) and add indexEntry to index.json. status 'pending': the local copy stays (and keeps protecting its models) until a sync installs newTemplateId, then it is removed. status 'adopted': newTemplateId was already installed with the same graph and parameters, the local copy is removed now. The local copy is only ever removed when the installed registry template has the same graph and parameters; an id already installed with other content is refused (media_template_invalid), and a sync that finds other content under the id keeps the local copy and lists it under invalid. A template that would not pass the registry checks as it is (e.g. a free-text model parameter) is refused with media_template_invalid, details.problems and details.template. Calling it again returns the same file. Agree it with the owner first; recorded as done by the Factory Operator.",
      inputSchema: adoptTemplateInput,
    },
    async (args) => {
      const input = parseInput(adoptTemplateInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.adoptTemplate(input));
    }
  );

  registerTool(
    "factory_media_get_settings",
    {
      description:
        "Read the owner's factory settings (Servers → Setup) without a session: { settings: { factorySessionsEnabled, limits: { maxUsdPerSession, maxMinutesPerSession, maxUsdPerDay, maxUsdPerMonth }, spentOrReservedUsd: { today, thisMonth } (your sessions' spend plus what open ones may still spend up to their caps -- what a start is checked against), device: { maxUsdPerDay, spentTodayUsd (this computer only; a start also counts other computers on the same RunPod account), maxConcurrentSessions, idleMinutes }, gpu: { gpuTypeId, fallbackIds, minVramGb, maxPricePerHr, onDemandPricePerHr, cloudType, minCudaVersion (1.7.0: the lowest host CUDA a pod may land on, null = any), cudaVersions (1.9.0: the values a minimum may take, ascending) }, capacity: { retrySeconds, waitMinutes }, hfToken: 'set' | 'not set' (1.22.0: a Hugging Face read token is stored and readable on this computer; never its value) } }. Days and months are this computer's local calendar. No secrets. Read-only, no RunPod call.",
      inputSchema: emptyInput,
    },
    async () => successResult(await deps.media.getSettings())
  );

  // -- BL-133: GPU sessions within the owner's factory limits, jobs in them, the capacity log ---------------------------

  registerTool(
    "factory_media_start_session",
    {
      description:
        "Start a GPU session yourself: { channelId (the connected channel whose workspace receives the outputs), maxMinutes?, maxUsd? (both default to the owner's factory per-session limits), templateId? (use that registry template's GPU list and its minCudaVersion) | gpu? { candidates: [GPU type ids in order], minVramGb?, maxPricePerHr? }, minCudaVersion? (1.9.0: one of gpu.cudaVersions; this session's own minimum host CUDA, wins over the template's; it may only RAISE the owner's minimum -- a lower value is used as the owner's), releaseWhenDone? (true = the pod stops by itself one minute after the last job finished, stopReason 'released after last job ...'; false = it stays up until the idle timeout or your stop; omitted = the owner's setting, on by default), runtimeId? (1.23.0: the pod runtime profile to run -- see factory_media_list_runtimes; omitted = the active runtime, null = the image's built-in ComfyUI; a runtime that is not built is refused with media_runtime_not_ready before any pod or session exists; the session shows runtimeId and, once running, comfyVersion) }. Within ALL of the owner's factory limits (the switch, per session, the factory's day and month) and the device's own limits, it is approved by you and the pod starts at once -> { session, approved: true }. Otherwise it is created pending for the owner -> { session, approved: false, heldBy: which limit }. 1.28.0: both answers carry gpuSkipped: [{ gpuTypeId, kind, reason }] -- the candidates the start skips before any try, from one RunPod catalog read made at start: kind 'stock' (not in RunPod's catalog, or not offered in the volume's datacenter) or 'config' (VRAM under the minimum, price over the cap, no price under a cap; the reason names the bound: '(Settings)' or '(session)'); [] = none skipped, null = the catalog could not be read, or the request is held (nothing starts; a request held by the factory limits reads no catalog, one held by a device limit may already have read it once). GPUs are tried in order in the volume's datacenter; if none can be placed -- or every candidate was skipped and at least one skip is 'stock' (the catalog is often wrong; nothing is tried, the next round re-reads it) -- the session waits as waiting_capacity (no pod, no cost) and is retried every 30 s until the owner's wait limit, then fails with media_no_capacity; the waiting and failure texts name the skipped candidates and their reasons. Only 'config' skips with no candidate left fail at once (media_session_start_failed). 1.24.0: a pod whose container has not started within settings.capacity.containerStartMinutes of its placement (default 3 min: a host without the image cached, or a faulty one) is terminated then -- not after the whole start budget -- logged container_stuck in the capacity log, and the session is placed again up to containerStuckRetries times (default 1), else it fails with media_container_stuck; while it starts the session shows startStage (placed | pulling_image | comfy_booting | ready) and stageSince. Pods are placed only on hosts whose CUDA driver supports the higher of the owner's minimum (gpu.minCudaVersion in factory_media_get_settings, 12.8 by default) and the session's own (1.9.0); before running, the host is checked again (its CUDA version, and a cuda device in ComfyUI) -- an incompatible pod is terminated and placed again at most twice, then the session fails with media_gpu_host_incompatible (1.7.0). With release-when-done, a session whose every job failed stops with stopReason 'all jobs failed (release when done)' (1.7.0). Poll factory_media_get_session.",
      inputSchema: startSessionInput,
    },
    async (args) => {
      const input = parseInput(startSessionInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.startSession(input));
    }
  );

  registerTool(
    "factory_media_get_session",
    {
      description:
        "One of YOUR sessions by sessionId ({ session }: status pending|approved|waiting_capacity|starting|running|stopping|done|failed|rejected|interrupted, approvedBy, gpuTypeId it got, costPerHr, capacity { attempts, nextAttemptAt, waitUntil }, usdCharged, error, minCudaVersion (the session's own, null = the owner's only), usedMinCudaVersion (the minimum its last placement attempt used; null = no filter, or none attempted yet -- the start's own answer may still show null), hostCudaVersion (the current pod's host CUDA, null = not known yet) -- 1.9.0), or your recent sessions ({ sessions }). Sessions you did not start are not visible. Read-only.",
      inputSchema: optionalSessionIdInput,
    },
    async (args) => successResult(await deps.media.getSession(parseInput(optionalSessionIdInput, args)))
  );

  registerTool(
    "factory_media_stop_session",
    {
      description: "End a session YOU started: { sessionId }. A pending one is withdrawn, a waiting one ends at no cost, a starting/running pod is terminated. Stop as soon as your jobs are done.",
      inputSchema: sessionIdInput,
    },
    async (args) => {
      const input = parseInput(sessionIdInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.endSession(input));
    }
  );

  registerTool(
    "factory_media_create_job",
    {
      description:
        "Submit a generation job to one of YOUR running sessions: { sessionId, templateId, params }. The same contract as the channel agents' agent_create_media_job (parameters validated first; image/audio/video inputs are paths relative to the session channel's 99 Data Exchange/Sent to YTM/; outputs and manifest.json land in that channel's From YTM/media/<jobId>/). A template whose minCudaVersion is above the session host's known CUDA is refused with media_gpu_host_incompatible before anything runs (1.9.0). Poll factory_media_get_job. BL-184 (1.16.0): a video whose first and last frames are two different images needs an approved storyboard: give storyboardId + segmentId of the approved latest version, its segment's from/to keyframes being exactly the two frames (same files by sha256); otherwise storyboard_not_approved (details.reason: no_link | not_found | not_approved | segment_not_found | frames_mismatch) and nothing is sent or charged. One image (a first frame only, or the same file as both) never needs one. A template's first/last frames are its image parameters tagged role: first_frame / last_frame in the registry (a template without roles is not seen as first/last-frame). The job shows storyboard { storyboardId, versionNumber, segmentId } or null. BL-194 (1.20.0): videoNumber? (a video of the session's channel, e.g. 'V49', from factory_video_create / factory_video_list) -- omitted, the job takes its storyboard's video, else its plan's; the job shows video ('V49' or null = not linked). A number the channel cannot link is refused before anything is sent or charged: video_not_found (unknown or cancelled) or video_in_dispute (two computers reserved it).",
      inputSchema: createJobInput,
    },
    async (args) => {
      const input = parseInput(createJobInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.createJob(input));
    }
  );

  registerTool(
    "factory_media_get_job",
    {
      description: "One job of YOUR sessions by jobId ({ job }), or the jobs of one of your sessions ({ jobs }, sessionId required then). Same job shape as the channel tools, including the live `progress` from ComfyUI while a job generates (BL-144), plus errorCode (1.7.0): 'media_gpu_host_incompatible' when the job's error says the GPU host's CUDA driver is too old ('CUDA driver version is insufficient', 'NVIDIA driver on your system is too old'; start a new session, the pod's host could not run the image), else null -- also for 'no kernel image is available', a GPU-architecture mismatch another host of that GPU type repeats. Read-only.",
      inputSchema: getJobInput,
    },
    async (args) => successResult(await deps.media.getJob(parseInput(getJobInput, args)))
  );

  registerTool(
    "factory_media_cancel_job",
    {
      description: "Cancel a queued or generating job of YOUR sessions: { jobId }. Never stops the session.",
      inputSchema: jobIdInput,
    },
    async (args) => {
      const input = parseInput(jobIdInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.media.cancelJob(input));
    }
  );

  registerTool(
    "factory_media_capacity_log",
    {
      description:
        "Every pod start attempt on this computer, newest first: { attempts: [{ at, sessionId, datacenterId, gpuTypeId, pricePerHr, result: placed|no_capacity|error, detail, hostCudaVersion (1.9.0: on a placed entry, the host's CUDA once known; else null) }] } -- { since? (ISO time), gpuTypeId?, limit? (default 100, max 500) }. Kept 90 days. Use it to judge whether a GPU is usually available. Read-only.",
      inputSchema: capacityLogInput,
    },
    async (args) => successResult(await deps.media.capacityLog(parseInput(capacityLogInput, args)))
  );

  registerTool(
    "factory_media_get_gpu_availability",
    {
      description:
        "RunPod's GPU stock and price per datacenter NOW (BL-172): two live catalog reads, no pod, no cost, always Secure Cloud (network volumes exist only there). { availability: { checkedAt, cloud (\"SECURE\"), volumeDataCenterId (the configured volume's), minVramGb, minCudaVersion, gpus: [{ gpuTypeId, displayName, vramGb, pricePerHr (Secure on-demand USD/h for one GPU, per GPU type -- RunPod gives no per-datacenter price), stock (overall: NONE|LOW|MEDIUM|HIGH), cudaAvailable (a CUDA version >= minCudaVersion has capacity now -- for the GPU type as a whole, not per datacenter; with a minimum RunPod lists only versions at or above it, so none listed = false; null only without a minimum, when RunPod lists no version), dataCenters: [{ dataCenterId, stock, networkVolume (RunPod offers network volumes there), s3Api }] }], dataCenters: [{ dataCenterId, region, countryCode, networkVolumeTypes (STANDARD / HIGH_PERFORMANCE; empty = none), s3Api }] } } -- { gpuTypeIds?, dataCenterIds?, minVramGb? (default: the Settings minimum, 24 when unset), minCudaVersion? (default: the Settings' minimum; the stock is counted on hosts with at least that CUDA) }. A datacenter missing from a GPU's list had no stock for it; a GPU's list keeps RunPod's order, the top-level datacenters are sorted by id. `s3Api` is RunPod's documented S3 endpoint list (YT Manager reaches a volume only over S3; storage status confirms it once a volume exists there). Stock can change between this read and a pod start; the capacity log of real attempts stays the ground truth. Needs the media gateway on and RunPod configured. Read-only.",
      inputSchema: gpuAvailabilityInput,
    },
    async (args) => successResult(await deps.media.gpuAvailability(parseInput(gpuAvailabilityInput, args)))
  );

  registerTool(
    "factory_media_list_gpu_availability_log",
    {
      description:
        "RunPod's GPU stock as THIS computer stored it every 15 minutes (1.26.0; every 3 hours before), kept 90 days (BL-172, BL-206). Each snapshot: for every GPU of 24 GB or more (Secure Cloud, read with one CUDA minimum -- 1.28.0: one snapshot per minimum in use, the Settings' and every installed template's, all at the same time), one overall row (dataCenterId \"*\", always) and one row per datacenter that offers network volumes where the GPU's stock there was not NONE -- 1.26.0: a datacenter without a row in a snapshot was NONE there (snapshots before 1.26.0 also stored those NONE rows). { log: { intervalHours (0.25), retentionDays, lastSnapshotAt (of the minimum read), minCudaVersion (1.28.0: the CUDA minimum read, null = none), minCudaVersions (the minimums with snapshots in the range, ascending; null = none), rows: [{ at, gpuTypeId, dataCenterId, stock (NONE|LOW|MEDIUM|HIGH; null = RunPod gave no level), pricePerHr (the GPU type's Secure on-demand USD/h), minCudaVersion }] } }, newest first -- or, with summary: true, { log: { …, summary: { snapshots (the snapshots taken in the range; gpuTypeId/dataCenterId do not narrow it), firstAt, lastAt, entries: [{ gpuTypeId, dataCenterId, snapshots (the snapshots the GPU was read in), stock: { HIGH?: n, MEDIUM?: n, LOW?: n, NONE?: n, UNKNOWN?: n } }] } } } counted over every matching row, NONE = the GPU's snapshots − its other levels there (the same numbers as when NONE was stored). A GPU × datacenter that was NONE in every snapshot of the range has no entry, unless both gpuTypeId and dataCenterId are given. For hours, weekdays and session waits use factory_media_get_gpu_stats. -- { since?, until? (ISO date-times), gpuTypeId?, dataCenterId?, limit? (1–5000, default 1000; rows only), summary?, minCudaVersion? (1.28.0: one of gpu.cudaVersions; default the Settings' minimum -- every row and count is of that minimum's snapshots only) }. Snapshots are taken only while the media gateway is on and RunPod is configured; each computer keeps its own log. Read-only, local, no RunPod call.",
      inputSchema: gpuAvailabilityLogInput,
    },
    async (args) => successResult(await deps.media.gpuAvailabilityLog(parseInput(gpuAvailabilityLogInput, args)))
  );

  registerTool(
    "factory_media_get_gpu_stats",
    {
      description:
        "GPU availability and session-wait statistics from what THIS computer stored (1.26.0, BL-206): the 15-minute availability snapshots and its media sessions. Local and read-only -- never calls RunPod, costs nothing. { stats: { from, to, hoursUtc, weekdays, intervalMinutes (15), minCudaVersion (1.28.0: the CUDA minimum whose snapshots are counted, null = none), minCudaVersions (the minimums with snapshots in the window, ascending), snapshots (taken in the window, of that minimum), availability: [{ gpuTypeId, dataCenterId (\"*\" = RunPod's overall stock), snapshots (those the GPU was read in), inStock (a level LOW/MEDIUM/HIGH), inStockShare (0..1, null without snapshots), unknown (listed there without a level: neither in stock nor NONE), stock: { HIGH?, MEDIUM?, LOW?, NONE?, UNKNOWN? }, byHourUtc: [24 × { snapshots, inStockShare }] (index = UTC hour), byWeekday: [7 × { snapshots, inStockShare }] (index 0 = Monday) }], sessions: { count, ready, failed, stopped (ended before ready otherwise: a stop, a reject, an app restart), open, failureRate (failed / (ready + failed)), medianWaitMinutes, p90WaitMinutes (nearest rank over the ready sessions; failures excluded), approximateWaits (sessions from before 1.26.0: their first approval is their earliest capacity attempt), failures: { reason: n } (the code the error starts with before ':', e.g. media_no_capacity; any other text is 'other'), byCandidates: [{ candidates, ...the same counts }], byGpu: [{ gpuTypeId (obtained), ready, medianWaitMinutes, p90WaitMinutes }], list?: [{ sessionId, requestedBy, status, outcome: ready|failed|stopped|open, candidates, datacenterId, firstApprovedAt, waitApproximate, readyAt, waitMinutes (ready − first approval; a capacity retry or re-placement does not restart it), gpuTypeId, capacityAttempts, skipped: [{ gpuTypeId, reason, kind? }] (candidates the first placement skipped before any try, e.g. not offered in the volume's datacenter; kind stock | config from 1.28.0, absent on older records; null = not recorded), failureReason, usdCharged }] (newest first, at most 500), listTruncated? } } } -- { from?, to? (ISO date-times; default the last 7 days to now; at most 90 days, from after to or a longer window = invalid_request), gpuTypeIds?, dataCenterIds? (a named datacenter without stock gets an all-NONE entry per GPU; \"*\" adds the overall rows, which are listed by default only without dataCenterIds), hoursUtc?: { from 0-23, to 1-24 } (UTC, to exclusive; from > to wraps past midnight), weekdays? [1 = Monday … 7 = Sunday], includeSessions? (default false), minCudaVersion? (1.28.0: one of gpu.cudaVersions; default the Settings' minimum) }. Hours and weekdays filter the snapshots by their time and the sessions by their first approval; sessions are those first approved in the window, every requester (owner and factory), filtered by datacenter and by GPU (a candidate or the GPU obtained). Candidates: the ordered, de-duplicated list a start tries -- the session's own plan, else the Settings' GPU and fallback list as they are now; null when its stored plan is unreadable.",
      inputSchema: gpuStatsInput,
    },
    async (args) => successResult(await deps.media.gpuStats(parseInput(gpuStatsInput, args)))
  );

  // -- BL-143 (ADR 0029): generation plans. The plans core validates every field strictly (bounds, patterns); the schemas
  // here only name the top-level fields. Writes pass the device mutation gate and are recorded as done by the factory.

  const planWrite = (name: (typeof FACTORY_TOOL_NAMES)[number], description: string, schema: z.ZodTypeAny, call: (input: unknown) => Promise<Record<string, unknown>>) =>
    registerTool(name, { description, inputSchema: schema }, async (args) => {
      const input = parseInput(schema, args);
      await deps.assertMutationAllowed();
      return successResult(await call(input));
    });
  const planRead = (name: (typeof FACTORY_TOOL_NAMES)[number], description: string, schema: z.ZodTypeAny, call: (input: unknown) => Promise<Record<string, unknown>>) =>
    registerTool(name, { description, inputSchema: schema }, async (args) => successResult(await call(parseInput(schema, args))));

  const loose = z.array(z.object({}).passthrough());
  planWrite(
    "factory_plan_create",
    "Create a generation plan on this computer: { planId (2-80 letters, digits, '.', '_', '-'; yours, unique here), title, channelId (a connected channel; its workspace gets the outputs), budget?: { usd?, gpuMinutes? } (a warning only), note?, stages: [{ stageId, title, kind: in_app | external | owner_review }] (at most one in_app -- fed by the plan's jobs -- and one owner_review), groups?: [{ groupId, title?, dependsOn?, note? }] (waves), items?: [{ itemKey, groupId?, templateId?, templateLabel?, variant?, targetCount, mode?: fixed | until_accepted, maxAttempts?, params? (job params as in create_job), seeds?, storyboard? ({ storyboardId, segmentId }, 1.16.0: the storyboard segment the item's videos render; every job a run creates from it names it to the storyboard gate, as factory_media_create_job does) }], references?: [{ id, label, file (relative to the channel's '99 Data Exchange/Sent to YTM/', e.g. 'reference/koto-01.mp3'), lufs?, lra?, truePeak? }] (reference tracks for the owner's A/B listening, up to 50; 1.13.0: also pictures and clips -- png/jpg/webp/mp4/webm, e.g. a cast sheet, a style plate, a base frame -- which the owner compares with a picture or clip side by side, as a wipe or as the difference; a file may also be 'From YTM/gemini/<jobId>/<file>', a Gemini output in place), reviewRejected?: boolean (1.6.0: validator-rejected attempts that can be played -- an auditionFile or a job of the plan -- also wait for the owner's review; default false), reviewReasons?: [string] (1.13.0: the reason chips the owner's review offers, <= 20, each <= 60 characters, recorded as written; a wave's own groups[].reviewReasons win; without a list the screen offers its defaults for the media kind: images, video or music) } -> { plan, progress }. 1.13.0: items[].pickTarget (1..targetCount) = how many attempts the owner picks for the item; default 1 for fixed, targetCount for until_accepted. Errors: plan_invalid (id taken, unknown channel, duplicate ids, unknown group, pickTarget outside 1..targetCount), validation_failed. BL-194 (1.20.0): videoNumber? (a video of the plan's channel, e.g. 'V49') -- the plan's jobs take it unless they name another or their storyboard has one; the plan shows video ('V49' or null); refusals video_not_found, video_in_dispute.",
    z.object({ planId: z.string(), title: z.string(), channelId: z.string(), videoNumber: z.string().nullable().optional(), budget: z.object({}).passthrough().optional(), note: z.string().nullable().optional(), stages: loose, groups: loose.optional(), items: loose.optional(), references: loose.optional(), reviewRejected: z.boolean().optional(), reviewReasons: z.array(z.string()).optional() }).strict(),
    (input) => deps.plans.create(input)
  );
  planWrite(
    "factory_plan_import",
    "Import a plan file in the ytm-generation-plan/1 format: { plan: <the file's JSON object> } -> { plan, progress, linkedJobs, importedResults }. Item templateId strings are kept as labels (templateLabel). A top-level reviewRejected: boolean is kept (1.6.0); 1.13.0: a top-level reviewReasons, groups[].reviewReasons and items[].pickTarget too. A generate result 'job:<id>' naming a job of this channel that is in no plan is linked to the plan (its live state then counts); other attempts are kept as imported rows. The planId must be new here.",
    z.object({ plan: z.object({}).passthrough() }).strict(),
    (input) => deps.plans.importPlan(input)
  );
  planWrite(
    "factory_plan_update",
    "Change an active plan: { planId, title?, note?, budget?, addStages?, upsertGroups? (an existing groupId is replaced), upsertItems? (an existing itemKey is replaced; its attempts stay), removeStageIds?, removeGroupIds?, removeItemKeys?, upsertReferences? (an existing id is replaced; a reference file may be a picture or clip, and 1.13.0 a 'From YTM/gemini/<jobId>/<file>' Gemini output in place), removeReferenceIds?, reviewRejected? (1.6.0: true = validator-rejected attempts that can be played also wait for the owner's review; 1.13.0: switching it off -- or removing a stage -- withdraws the owner's pick of an attempt that leaves the queue, owner_unpick reason left_queue), reviewReasons? (1.13.0: the plan's reason chips; null removes them; upsertGroups[].reviewReasons sets a wave's, null removes it; upsertItems[].pickTarget) } -> { plan, progress }. A stage or item with attempts or results cannot be removed; a group with items cannot be removed (plan_invalid).",
    z
      .object({
        planId: z.string(),
        title: z.string().optional(),
        note: z.string().nullable().optional(),
        videoNumber: z.string().nullable().optional(),
        budget: z.object({}).passthrough().optional(),
        addStages: loose.optional(),
        upsertGroups: loose.optional(),
        upsertItems: loose.optional(),
        removeStageIds: z.array(z.string()).optional(),
        removeGroupIds: z.array(z.string()).optional(),
        removeItemKeys: z.array(z.string()).optional(),
        upsertReferences: loose.optional(),
        removeReferenceIds: z.array(z.string()).optional(),
        reviewRejected: z.boolean().optional(),
        reviewReasons: z.array(z.string()).nullable().optional(),
      })
      .strict(),
    (input) => deps.plans.update(input)
  );
  planWrite(
    "factory_plan_move",
    "Move an active plan to another channel connected on this computer (1.8.0): { planId, channelId, checkOnly?: boolean } -> { planId, from, to, checked, missing, missingCount, unfinishedJobs, moved }. Copy the plan's files into the new channel's '99 Data Exchange/Sent to YTM/' first (1.13.0: a 'From YTM/gemini/<jobId>/...' file to the same folder of the new channel's '99 Data Exchange/From YTM/'): every auditionFile reported on the plan, the file of every open re-check and accepted revision (1.11.0) and every reference file is checked there (checked = how many distinct files; missing lists up to 500 of the missingCount not found). checkOnly: true only checks and changes nothing. Without it, a missing file or an unfinished job of the plan (queued or running) refuses the move with plan_invalid (details: checked, missing, missingCount / unfinishedJobs) and nothing changes. After the move, the auditionFiles and references play from the new channel; an attempt with no auditionFile plays its job's output from the channel the job ran on; runs and plan-linked sessions need the new channel. Jobs, sessions, results, verdicts, events and spend stay with the plan (same planId). Event plan_moved { from, to, checked }. A plan with an open re-check does not move (1.11.0: plan_invalid, details.reason recheck_open -- withdraw it or wait for the owner's answer). Errors: plan_closed, plan_invalid (same channel, channel not connected, no workspace folder, files missing, unfinished jobs, an open re-check), plan_not_found.",
    z.object({ planId: z.string(), channelId: z.string(), checkOnly: z.boolean().optional() }).strict(),
    (input) => deps.plans.move(input)
  );
  planWrite(
    "factory_plan_close",
    "Close a plan: { planId, status: completed | cancelled, note? } -> { plan, progress }. Only the status changes: running jobs, sessions and files are not touched (cancel jobs with factory_media_cancel_job); open re-checks are withdrawn (1.11.0: event recheck_withdrawn { recheckId, reason: plan_closed }). A closed plan refuses every change (plan_closed).",
    z.object({ planId: z.string(), status: z.string(), note: z.string().nullable().optional() }).strict(),
    (input) => deps.plans.close(input)
  );
  planRead(
    "factory_plan_get",
    "One plan with its derived progress and events: { planId, since? (ISO time: only events after it) } -> { plan, progress: { stages: [counts planned/queued/running/done/failed/interrupted/cancelled/accepted/rejected], groups (1.13.0: counts.picked, counts.noneFits), items (attempts, generated, accepted, rejected, open, waitingReview, missing; 1.13.0: pickTarget, picks: [{ attemptRef, device, at, note }], noneFits: { note, device, at, attempts } | null, notChosen -- attempts without a verdict that no longer wait because the item has its picks or a 'none fits' covering them; never counted as rejected; picked attempts count as accepted, and attempts only external stages report count in attempts/accepted/missing), spend: { usd, gpuMinutes, sessions }, budget: { usd, usedShare, warnings: ['80'|'100'] }, eta: { seconds, gpuTypeId, samples }, notices: [stage_complete | budget_80 | budget_100 | plan_complete | attempts_exhausted { count } | review_waiting { count, passed, rejected } (1.6.0: rejected ones wait only with the plan's reviewRejected)] }, events: [{ at, kind, actor, details }], more, cursor }. Events are the oldest first at or after since; the cursor looks back a minute (some events are stamped just before they are stored) and times have one-second resolution, so events repeat across calls -- drop what you already have. more = true means call again with the cursor at once. If more than 500 events share one second, the excess of that second is skipped. Events: job_created/done/failed/interrupted/cancelled, session_started/ready/stopped (stopReason), result_reported, owner_verdict (rating, reasons, markers, note; overridesValidator: true when the owner accepted an attempt an earlier stage rejected), group_note, group_reviewed { groupId, accepted, rejected, overridesValidator, picked, noneFits } (1.8.0: the owner's verdicts took the wave's waiting count to zero -- recorded once per completion; 1.13.0: picks and 'none fits' finish a wave too, picked/noneFits count them), owner_pick { itemKey, attemptRef, device, note?, overridesValidator?, reviewSeconds? } / owner_unpick { itemKey, attemptRef, device, reason: withdrawn | moved | rejected | none_fits | left_queue } / owner_none_fits { itemKey, device, note, attempts, reviewSeconds? } or { itemKey, device, cleared: true } (1.13.0: the owner picked one attempt of N -- not a verdict: no result row, no owner_verdict; an attempt is never both picked and rejected; reviewSeconds? on owner_pick, owner_none_fits, owner_verdict and recheck_answered = the owner's seconds on the attempt -- a pick or none fits: on the item's attempts -- before deciding, counted while the review tab was visible and the owner active; absent = not measured; ignored on unpick and clear), peer_pick { pickId, fromDevice, itemKey, attemptRef?, action, unchanged? | superseded?, reason? } (1.13.0: a pick given on the other computer was weighed here), rerun_requested, plan_moved { from, to, checked } (1.8.0), recheck_requested { recheckId, kind, itemKey, attemptRef, title } / recheck_answered { recheckId, kind, itemKey, attemptRef, kept, result, device, note? (a kept answer's note), replaced? (true: a newer verdict from the other computer became the answer of an already answered re-check) } / recheck_withdrawn { recheckId, itemKey, attemptRef, note?, reason? } (1.11.0; owner_verdict carries recheckId when it answers a re-check, and a kept answer gives no owner_verdict), plan_*. 1.11.0: progress.rechecksOpen and groups[].counts.rechecks count the open re-checks (never part of waitingReview); progress.rechecks lists every re-check { recheckId, itemKey, attemptRef, kind, title, note, auditionFile, markers, checks, metrics, previousVerdict, status: open | answered | withdrawn, openedAt, closedAt, answer: { result, kept, rating, reasons, markers, note, device, at } | null, withdrawNote, closeReason, currentFile } -- currentFile = the file the attempt plays now: the auditionFile of its newest revision the owner accepted, else its latest reported auditionFile (null = only its job output); deliver that file. Groups carry ownerNote (1.8.0: the owner's note on the wave; note is the factory's context, never overwritten by the owner). In-app counts are read from the jobs themselves. Read-only.",
    z.object({ planId: z.string(), since: z.string().optional() }).strict(),
    (input) => deps.plans.get(input)
  );
  planRead(
    "factory_plan_list",
    "This computer's plans with their progress: { status?: active | completed | cancelled, channelId? } -> { plans: [{ plan, progress }] }. Read-only.",
    z.object({ status: z.string().optional(), channelId: z.string().optional() }).strict(),
    (input) => deps.plans.list(input)
  );
  planRead(
    "factory_plan_todo",
    "What is left in a plan: { planId } -> { short: [{ itemKey, groupId, missing, mode }] (attempts still needed), waitingReview: [{ itemKey, attemptRef, validator: passed | rejected }] (passed the stage before owner review -- or, with the plan's reviewRejected, was rejected there and can be played -- and has no verdict yet; 1.13.0: nor a pick, nor an item decided without it), rerun: [{ itemKey, attemptRef, state: failed | interrupted }] (only while the item is short), rechecks: [{ recheckId, kind, itemKey, attemptRef, openedAt }] (1.11.0: the open re-checks, oldest first -- waiting for the owner apart from waitingReview) }. Read-only.",
    z.object({ planId: z.string() }).strict(),
    (input) => deps.plans.todo(input)
  );
  planWrite(
    "factory_plan_report",
    "Report results of external stages (post-process, validator) or a verdict you relay from chat, in bulk: { planId, rows: [{ stageId (not the in_app stage), itemKey, attemptRef ('job:<jobId>' of the generate job), result: done | failed | accepted | rejected, note? (<= 2000), auditionFile? (the file the owner should hear: a path relative to the channel workspace's '99 Data Exchange/Sent to YTM/'; 1.13.0: or 'From YTM/gemini/<jobId>/<file>' -- a Gemini job's output, reviewed where it is, no copy), checks?: [{ id, label?, value?, unit?, threshold?, pass, severity: info | warn | fail, atSeconds?: [start, end], detail? (<= 200) }] (<= 50), metrics? (<= 50 keys; 1.13.0: fps -- a clip's frame rate for frame steps -- and loop: true -- a clip meant to loop, which gets the seam tools: the last second into the first, five passes in a row, the last and the first frame), rating? (1-10), reasons?, markers?: [{ start, end?, note?, region? (1.13.0: a pin on a picture, { x, y, r } each 0..1 -- x of the width, y of the height, r of the shorter side; for an image start 0, for a video the frame at start) }], referenceIds? (<= 5 ids of the plan's references nearest to this attempt, e.g. your nearest library tracks: the owner's A/B offers them first) }] (<= 200 rows) } -> { stored }. One row per (plan, stage, item, attempt): a repeat replaces it -- except the owner's own verdict, which a relayed owner_review row never replaces (plan_mismatch). All rows are checked first; one bad row stores nothing (plan_mismatch / validation_failed). Each row is recorded as reported by the factory. 1.13.0: rows of an attempt that only external stages report (e.g. an image or clip made outside the app, with a png/jpg/webp/mp4/webm auditionFile) count in the item's attempts, accepted and missing like the app's own jobs; the owner reviews images and video in the same screen. A picked attempt loses its pick when a relayed owner_review row rejects or fails it (owner_unpick reason rejected) or a row of the stage before the review fails or rejects it so it leaves the owner's queue (reason left_queue).",
    z.object({ planId: z.string(), rows: loose }).strict(),
    (input) => deps.plans.report(input)
  );
  planWrite(
    "factory_plan_run_stage",
    "Create the jobs a plan still needs, in one of YOUR running sessions for the plan's channel: { planId, sessionId, itemKeys? | groupId? (default: every item) } -> { created: [{ itemKey, jobId, seed }], skipped: [{ itemKey, missing, reason }], stoppedAt }. Per item: fixed -- up to what the target still misses; until_accepted -- as many as the target still misses (accepted + pending counted), within maxAttempts. An item that lists seeds gets one job per unused seed (a failed or interrupted attempt frees its seed) and is never run without one: when its seeds run out it is listed in skipped. An item without seeds gets that many jobs. At most 200 jobs per call (more: plan_mismatch; run per group or item). Runs of one plan are serialized. Each job gets the item's params, plus its seed in the template's 'seed' parameter. Every job is checked first (session running, yours, the plan's channel and not another plan's; template and params valid); any problem refuses all (plan_mismatch) and creates nothing -- except a template whose minCudaVersion is above the session host's known CUDA, refused with media_gpu_host_incompatible (1.9.0: start a session with that minimum). Input files (image/audio/video params from Sent to YTM) are checked only when each job is created. If creating a job fails after the checks (e.g. ComfyUI down), the jobs before it exist and stoppedAt says where it stopped. The session is linked to the plan for its spend. Nothing ever runs without this call.",
    z.object({ planId: z.string(), sessionId: z.string(), itemKeys: z.array(z.string()).optional(), groupId: z.string().optional() }).strict(),
    (input) => deps.plans.runStage(input)
  );
  planWrite(
    "factory_plan_rerun",
    "One more attempt of one item in one of YOUR running sessions: { planId, sessionId, itemKey, seed? (a seed you give is used as given, even one used before; default: the item's next unused seed; an item that lists seeds and has none left is refused) } -> { created, skipped, stoppedAt }. Same checks as factory_plan_run_stage; an until_accepted item at maxAttempts is refused.",
    z.object({ planId: z.string(), sessionId: z.string(), itemKey: z.string(), seed: z.number().int().optional() }).strict(),
    (input) => deps.plans.rerun(input)
  );
  planWrite(
    "factory_plan_clone_group",
    "Build the next wave from a group: { planId, groupId, newGroupId, title?, paramsPatch? (merged into every copied item's params), seeds? (replace the copied seeds) } -> { plan, progress }. Items are copied as '<newGroupId>/<rest of the key>' with no attempts or results; the new group dependsOn the source.",
    z.object({ planId: z.string(), groupId: z.string(), newGroupId: z.string(), title: z.string().optional(), paramsPatch: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(), seeds: z.array(z.number().int()).optional() }).strict(),
    (input) => deps.plans.cloneGroup(input)
  );
  // BL-173 (FO-REQ-0017, PLAN_RECHECKS_PLAN.md §2.2): re-checks. The top-level fields are named and strict here; the plans core
  // checks every bound.
  planWrite(
    "factory_plan_request_recheck",
    "Send an attempt the owner already rated back to the owner (1.11.0): { planId, itemKey, attemptRef, recheckId (yours: letters, digits, '.', '_', '-', <= 120, unique in the plan), kind: revision | question, title (<= 60: the short reason the owner sees, e.g. 'резкость' or 'голос на 0:25'), note (<= 1000: what was wrong and what changed, or the question), auditionFile? (revision only and required: the fixed file, relative to the channel's '99 Data Exchange/Sent to YTM/', or 1.13.0 'From YTM/gemini/<jobId>/<file>' -- a Gemini output in place; a question plays the attempt's current file), markers?: [{ start, end?, note?, region? (1.13.0: a pin { x, y, r }, 0..1) }] (<= 50, the spots to check), checks? / metrics? (the validator's results for the fixed file, as in factory_plan_report rows) } -> { recheck }. Stored apart from the result rows: the attempt's rows and verdicts do not change. The owner sees it in Review under 'Re-checks', apart from the waves (not in waitingReview; an answer records group_reviewed only when it writes the attempt's first review row), and answers with a verdict -- which becomes the attempt's verdict; an accepted revision becomes its currentFile -- or, for a question, keeps the verdict with a note. Every answer goes into the verdict history with the recheckId (factory_plan_get events: recheck_answered, owner_verdict { recheckId }). The same recheckId with the same content again returns the stored re-check (a safe retry); with other content plan_recheck_exists. Refused: plan_not_found; plan_closed; plan_mismatch (unknown item or attempt; no verdict yet -- details.reason not_rated, it is in the queue already; an open re-check on the attempt -- recheck_open, withdraw it first; a revision without auditionFile; a question with one); plan_invalid (the file is not in Sent to YTM (or, for a 'From YTM/gemini/<jobId>/' path, in that Gemini job's folder) -- file_missing; not a type the player plays -- unsupported_type; no workspace folder). Do not report the fixed file as a factory_plan_report row: at the same key it would replace the original's row.",
    z
      .object({
        planId: z.string(),
        itemKey: z.string(),
        attemptRef: z.string(),
        recheckId: z.string(),
        kind: z.enum(["revision", "question"]),
        title: z.string(),
        note: z.string(),
        auditionFile: z.string().optional(),
        markers: loose.optional(),
        checks: loose.optional(),
        metrics: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])).optional(),
      })
      .strict(),
    (input) => deps.plans.requestRecheck(input)
  );
  planWrite(
    "factory_plan_withdraw_recheck",
    "Take an open re-check back (1.11.0): { planId, recheckId, note? (<= 1000) } -> { recheck }. It leaves the owner's queue on every computer; event recheck_withdrawn { recheckId, itemKey, attemptRef, note? }. An answered or withdrawn re-check is refused with plan_recheck_closed (details.status); an unknown one with plan_mismatch; an unknown plan with plan_not_found, a closed one with plan_closed.",
    z.object({ planId: z.string(), recheckId: z.string(), note: z.string().optional() }).strict(),
    (input) => deps.plans.withdrawRecheck(input)
  );

  // -- BL-174 (GEMINI_MEDIA_PLAN.md §2.7): Google's Gemini API. The module validates every field (per-model rules, bounds);
  // the schemas here name the fields so the operator sees them. No tool sets the key, the switch or the limits (Web only).

  const relativePath = z.string().min(1).max(500);
  const geminiCreateInput = z
    .object({
      channelId: z.string().min(1).max(64),
      kind: z.enum(["image", "video"]),
      model: z.string().min(1).max(80),
      prompt: z.string().min(1).max(10_000),
      requestId: z.string().min(1).max(120).optional(),
      dryRun: z.boolean().optional(),
      image: z
        .object({ size: z.string().max(10), aspectRatio: z.string().max(10), inputs: z.object({ images: z.array(relativePath).max(14).optional() }).strict().optional() })
        .strict()
        .optional(),
      video: z
        .object({
          resolution: z.string().max(10),
          aspectRatio: z.string().max(10),
          durationSeconds: z.number().int(),
          personGeneration: z.enum(["allow_all", "allow_adult"]).optional(),
          inputs: z.object({ firstFrame: relativePath.optional(), lastFrame: relativePath.optional(), referenceImages: z.array(relativePath).max(3).optional() }).strict().optional(),
        })
        .strict()
        .optional(),
      /** BL-184 stage 2: the storyboard segment this video renders (both, or neither). */
      storyboardId: z.string().min(1).max(40).optional(),
      segmentId: z.string().min(1).max(40).optional(),
      /** BL-194: the channel's video number this job is for (`video` is the video's settings); omitted: its storyboard's. */
      videoNumber: z.string().min(1).max(12).optional(),
    })
    .strict();
  const geminiGetJobInput = z
    .object({
      jobId: z.string().min(1).max(80).optional(),
      channelId: z.string().min(1).max(64).optional(),
      status: z.enum(["queued", "submitting", "running", "done", "failed"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict();

  registerTool(
    "factory_gemini_get_status",
    {
      description:
        "Images and video through Google's Gemini API (1.12.0; no server is rented, each result is paid): what you may do now. -> { enabled (the owner's switch, off by default), keyConfigured, keyHint (last 4 characters only), keyStatus ('ok' | 'payment_required': the Google prepaid balance is empty), gatewayEnabled (the owner's 'Media gateway' toggle), limits: { maxUsdPerJob, maxUsdPerDay, maxUsdPerMonth, maxActiveJobs }, spend: { todayUsd, monthUsd (finished jobs' costs + active jobs' estimates, this computer's local day/month), activeUsd, activeJobs, account (1.19.0): { todayUsd, monthUsd (this computer plus every other computer that uses the SAME Gemini key, from their spend reports -- what the per-day and per-month limits are checked against), keyKnown (false = no usable key here: only this computer counts), otherComputers: [{ deviceId, hostname, todayUsd, monthUsd, updatedAt, stale }] } }, pricesAsOf, models: [image: { model, label, sizes, usdPerImage, usdPerMillionTokens } | video: { model, label, resolutions, usdPerSecond (Omni: an estimate, billed by tokens), referenceImages, frames (first/last frames accepted), retiresOn (Google's shutdown date, YYYY-MM-DD, or null), usdPerMillionTokens? (Omni) }] }. Since 1.21.0 the only video model is gemini-omni-1.1-flash (the Veo 3.1 previews were removed; Google shuts them down 2026-10-22). Limits and spend are per computer. Read-only.",
      inputSchema: emptyInput,
    },
    async () => successResult(await deps.gemini.getStatus())
  );

  registerTool(
    "factory_gemini_create_job",
    {
      description:
        "Generate ONE image (Nano Banana) or ONE video (Gemini Omni) for a channel through Google's Gemini API, paid per result (1.12.0; Omni 1.15.0; Veo removed 1.21.0): { channelId, kind: 'image' | 'video', model, prompt, requestId? (yours, <= 120 letters/digits/'.'/'_'/'-': the same id with the same content returns the first job -- use it to retry safely; with other content gemini_request_exists), dryRun? (true: only { dryRun, estimateUsd, allowed, refusal, spend } -- nothing stored, no gate), image?: { size: '1K' | '2K' | '4K' (uppercase K; Nano Banana 2 Lite: 1K only), aspectRatio: 1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9, inputs?: { images: [up to 14 reference/edit images] } }, video?: { resolution: '720p' | '1080p', aspectRatio: '16:9' | '9:16', durationSeconds: 4 | 6 | 8, inputs?: { firstFrame?, lastFrame? (needs firstFrame) } } } -> { job } (status 'queued'; the app sends it within seconds). ONE image or video per job: the estimate and the per-job limit assume one image, so do not ask for several in one prompt (Google would make and charge each). Image models: gemini-nano-banana-2.1, gemini-3.1-flash-lite-image, gemini-3-pro-image; video: gemini-omni-1.1-flash (text-to-video, first frame, first + last frame -- a loop: the same file as both; one synchronous call, priced by Google's token counts, about $0.10 per second at 720p) -- see factory_gemini_get_status for prices. Input images are paths relative to the channel's 99 Data Exchange/Sent to YTM/ (png, jpg, jpeg, webp; <= 7 MB each, <= 12 MB together). Outputs and manifest.json land in the channel's 99 Data Exchange/From YTM/gemini/<jobId>/. Refusals: gemini_disabled (the owner's switch is off), gemini_key_missing, gemini_limit_exceeded (details.limit: per_job | per_day | per_month | active_jobs, with limitUsd, spentUsd, estimateUsd; since 1.19.0 per_day / per_month spentUsd is every computer on the same Gemini key, with otherComputersUsd when the others spent something), gemini_invalid_params (details.field), gemini_input_unavailable, gemini_workspace_unavailable, gemini_request_exists, validation_failed. Poll factory_gemini_get_job. Recorded as done by the Factory Operator. BL-184 (1.16.0): a video whose first and last frames are two different images needs an approved storyboard: give storyboardId + segmentId of the approved latest version, its segment's from/to keyframes being exactly the two frames (same files by sha256); otherwise storyboard_not_approved (details.reason: no_link | not_found | not_approved | segment_not_found | frames_mismatch) and nothing is sent or charged. One image (a first frame only, or the same file as both) never needs one. Checked after the inputs are read and before the estimate; a dryRun reports it as refusal. The job shows storyboard { storyboardId, versionNumber, segmentId } or null. BL-194 (1.20.0): videoNumber? (a video of the channel, e.g. 'V49'; `video` stays the video's settings) -- omitted, the job takes its storyboard's video; the job shows video ('V49' or null). A number the channel cannot link is refused before the estimate and any charge: video_not_found or video_in_dispute.",
      inputSchema: geminiCreateInput,
    },
    async (args) => {
      const input = parseInput(geminiCreateInput, args);
      if (!input.dryRun) await deps.assertMutationAllowed();
      return successResult(await deps.gemini.createJob(input));
    }
  );

  registerTool(
    "factory_gemini_get_job",
    {
      description:
        "One Gemini job by jobId -> { job }, or the newest jobs -> { jobs } (optional channelId, status, limit <= 50, default 20) (1.12.0). Job: { jobId, channelId, requestId, kind, model, prompt, params, inputs: [{ role, path, mimeType, bytes, sha256 }], status: queued | submitting | running (a video Google is still making) | done | failed, estimateUsd, costUsd, costBasis: usage (Google's token counts) | price_table | not_charged | unknown_outcome (sent, then lost: counted at its estimate), outputs: [{ path (relative to From YTM, e.g. gemini/<jobId>/image-1.png), localPath, kind, mimeType, bytes, sha256, assetId, note }], error, errorCode (gemini_blocked: change the prompt; gemini_invalid_request; gemini_rate_limited / gemini_unavailable after 3 attempts; gemini_payment_required; gemini_key_invalid; gemini_key_missing; gemini_disabled; gemini_input_changed; gemini_timeout; gemini_interrupted; gemini_expired; gemini_output_failed; media_gateway_disabled), attempts, createdBy, createdAt, submittedAt, finishedAt }. Unknown id: gemini_job_not_found. Read-only.",
      inputSchema: geminiGetJobInput,
    },
    async (args) => successResult(await deps.gemini.getJobs(parseInput(geminiGetJobInput, args)))
  );

  // -- BL-176 (LIVE_STREAMS_PLAN.md §3.4/§3.11): live streams. Reads the module's fixed-code status; the map is a local write.
  const liveStatusInput = z.object({ channelId: z.string().min(1).max(64).optional() }).strict();
  const liveMapInput = z
    .object({
      channelId: z.string().min(1).max(64),
      items: z.array(z.object({ videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/), file: z.string().min(1).max(500) }).strict()).min(1).max(200),
    })
    .strict();
  // BL-207: the shape only (language → { title, description }); the live-streams validator checks every code and bound.
  const liveLocalizationsInput = z
    .object({
      channelId: z.string().min(1).max(64),
      localizations: z.record(z.string().min(1).max(32), z.object({ title: z.string(), description: z.string() }).strict()),
    })
    .strict();

  registerTool(
    "factory_live_get_status",
    {
      description:
        "Live streams (1.14.0): every 24/7 stream on THIS computer and the ones other computers report (about 1-2 minutes behind), optionally for one channelId -> { streams: [{ device: { deviceId, hostName, thisComputer }, updatedAt, channelId, state: off | ended_by_youtube (start a new broadcast in the app) | starting | live | replaying (the next video is not on the Mac: the copied ones are replayed) | no_source | reconnecting, since (ISO, when the owner turned it on), playing: { index, total, videoId } | null, health: { lifeCycleStatus, streamStatus, healthStatus, issueTypes: [YouTube's configurationIssues types] } | null (polled every 5 minutes), lastInterruption: { at, cause: encoder_exit | source_missing | pass_end | replay_end } | null, viewers }], segments (1.25.0, this computer only): [{ channelId, enabled, lengthMinutes, switchHourUtc, recordingsPlaylist: { id, title } | null, current: { broadcastId, startedAt, switchDueAt } | null, segments: [{ broadcastId, startedAt, endedAt, overlapMs, rotation: [videoId], recording: none | recorded, playlist: none | pending | added | failed }] (last 30 days, newest first), failures: [{ at, stage: authorize | insert | bind | go_live | handover }], lastSwitchedAt }], localizations (1.27.0, this computer only): [{ channelId, localizations: { <language>: { title, description } } | null, problem: invalid_stored | null, warnings: [video_settings_not_saved | video_settings_invalid (the set is written only as part of the saved video settings) | baseline_language_in_set (the channel's base language is now in the set: the step fails on every broadcast until it is removed) | no_baseline (the channel has no base language: nothing is written)], lastStep: { at, broadcastId, ok, skipped?: fields_failed | stream_stopped | broadcast_replaced, failure?: read_back_mismatch | failed } | null }] }. While «Перезапуск эфира» is on, the app itself switches the broadcast before 12 h (the owner's setting). Streams run only on the Mac running the app as its system service; only the owner starts, stops or edits a broadcast, in the app. Never a key, URL or error text. Read-only, local (no YouTube call).",
      inputSchema: liveStatusInput,
    },
    async (args) => successResult(await deps.live.getStatus(parseInput(liveStatusInput, args)))
  );

  registerTool(
    "factory_live_map_sources",
    {
      description:
        "Tell the app which original file is which published video, for live streams (1.14.0): { channelId (connected here, with a workspace folder), items: [{ videoId (11 characters), file (a path relative to the channel workspace, '/' between folders, e.g. '04 Videos/10 October/1013 V47/V47 Japan Countryside Music.mp4') }] (1-200) } -> { results: [{ videoId, file, status: accepted | refused, reason?, detail? }] }. Each item is checked: the video is this channel's and public now (YouTube is asked: one read per call), the file is a regular file inside the workspace (no '..', no absolute path, no symlink out), and its duration is within 1 s of the video's, with AAC sound at 44.1/48 kHz, at most 2 channels. reason: not_channel_video | private | unlisted | scheduled | not_found | unknown | file_unavailable | no_video_stream | audio_unsupported | duration_unknown | duration_mismatch. Accepted items are stored (a later call replaces a video's file). The map only offers files: the owner builds the rotation and starts streams in the app; nothing here reaches a broadcast. Refused without a workspace folder: live_stream_workspace_unavailable. Passes the device mutation gate; recorded as done by the Factory Operator.",
      inputSchema: liveMapInput,
    },
    async (args) => {
      const input = parseInput(liveMapInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.live.mapSources(input));
    }
  );

  registerTool(
    "factory_live_save_localizations",
    {
      description:
        "Set the translations of a live stream's title and description (1.27.0): { channelId (a stream on THIS computer), localizations: { <language>: { title, description } } } -> { localizations (the stored set), warnings: [{ code: video_settings_not_saved | video_settings_invalid | baseline_language_in_set | no_baseline, message, language? }] }. One set per stream: every broadcast and every segment gets it, written after Start right after the video's fields (and only when they were written), as part of the stream's saved video settings -- without them nothing is written (a warning, not a refusal); likewise a set holding the channel's current base language (baseline_language_in_set, with language) or a channel without a base language (no_baseline) is saved with a warning, never written. The set REPLACES the stored one; {} clears it. A language must be an exact YouTube code (pt-BR, not pt-br: details give a hint), never the channel's base language; title 1-100 characters after trimming, description required, 1-5000 bytes, neither with < or >; at most 50 languages. Languages not in the set are left as they are on YouTube (nothing is deleted). Any refused language refuses the whole call (validation_failed, details.refused: [{ language, reason: unsupported_language | baseline_language | not_an_entry | title_empty | title_too_long | title_angle_brackets | description_empty | description_too_long | description_angle_brackets, message, hint? }]) and nothing is saved. No stream here: live_stream_not_found. Local only, no YouTube call; passes the device mutation gate; recorded as done by the Factory Operator.",
      inputSchema: liveLocalizationsInput,
    },
    async (args) => {
      const input = parseInput(liveLocalizationsInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.live.setLocalizations(input));
    }
  );

  // -- BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md §5, ADR 0047): a channel's own translations. The shape only; the module checks every code
  // and bound. The save passes the device mutation gate; neither tool can send anything to YouTube.
  const channelRefInput = z.object({ channelId: z.string().min(1).max(64) }).strict();
  const channelLocalizationsInput = z
    .object({
      channelId: z.string().min(1).max(64),
      localizations: z.record(z.string().min(1).max(32), z.object({ title: z.string(), description: z.string() }).strict()),
    })
    .strict();

  registerTool(
    "factory_channel_get_localizations",
    {
      description:
        "A channel's own name and description translations (1.29.0): { channelId (connected on THIS computer) } -> { channelId, stored: { localizations: { <language>: { title, description } } | null, problem: invalid_stored | null, baselineLanguage (the channel's base language here, null = none), updatedAt, updatedBy: owner | factory | null }, live: { defaultLanguage (brandingSettings.channel.defaultLanguage; null = not set: nothing can be applied until the owner sets it in YouTube Studio), localizations: { <language>: { title, description } } } | null (read from YouTube now: channels.list, 1 quota unit, nothing written), liveUnavailable: null | <code> (why live is null, e.g. data_api_reads_disabled, channel_not_connected, youtube_quota_exceeded), lastApply: { at, ok, languages (written), writes (0 or 1), failure?: read_back_mismatch | failed, code? (failed: the error code) } | null }. Only the owner's «Применить» in the app sends the stored set to YouTube. Never a token or error text.",
      inputSchema: channelRefInput,
    },
    async (args) => successResult(await deps.channelLocalizations.get(parseInput(channelRefInput, args)))
  );

  registerTool(
    "factory_channel_save_localizations",
    {
      description:
        "Save a channel's own name and description translations on THIS computer (1.29.0): { channelId (connected here), localizations: { <language>: { title, description } } } -> { localizations (the stored set) }. One set per channel; it REPLACES the stored one, {} clears it. A language must be an exact YouTube code (pt-BR, not pt-br: details give a hint), never the channel's base language; title 1-30 characters after trimming (the documented channel-title limit), description required, 1-1000 characters, neither with < or >; at most 50 languages. Any refused language refuses the whole call (validation_failed, details.refused: [{ language, reason: unsupported_language | baseline_language | not_an_entry | title_empty | title_too_long | title_angle_brackets | description_empty | description_too_long | description_angle_brackets, message, hint? }]) and nothing is saved. Not connected here: channel_not_connected. Local only: NOTHING is sent to YouTube -- the owner reviews and applies it in the app (languages not in the set stay as they are; nothing is deleted). Passes the device mutation gate; recorded as done by the Factory Operator.",
      inputSchema: channelLocalizationsInput,
    },
    async (args) => {
      const input = parseInput(channelLocalizationsInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.channelLocalizations.save(input));
    }
  );

  // -- BL-184 (FO-REQ-0024, STORYBOARD_PLAN.md §2.6): storyboards. The schemas here name the fields; the storyboards module checks
  // every bound and rule (ids, the chain of segments, the files). Writes pass the device mutation gate.
  const storyboardContent = {
    title: z.string(),
    loop: z.boolean(),
    keyframes: z.array(z.object({}).passthrough()),
    segments: z.array(z.object({}).passthrough()),
    props: z.array(z.object({}).passthrough()).optional(),
    notes: z.string().nullable().optional(),
  };
  const storyboardRef = z.object({ channelId: z.string(), storyboardId: z.string() }).strict();
  const storyboardWrite = (name: (typeof FACTORY_TOOL_NAMES)[number], description: string, schema: z.ZodTypeAny, call: (input: unknown) => Promise<Record<string, unknown>>) =>
    registerTool(name, { description, inputSchema: schema }, async (args) => {
      const input = parseInput(schema, args);
      await deps.assertMutationAllowed();
      return successResult(await call(input));
    });
  const STORYBOARD_SHAPE =
    "Storyboard: { storyboardId, channelId, title, planId, video (1.20.0: 'V49' or null), state: draft | in_review | changes_requested | approved, latestVersion, keyframes, segments (counts of the latest version), loop, createdAt, createdBy, submittedAt (of the latest version, or null), lastDecision ({ kind: approved | changes_requested, versionNumber, at, by, device, note } on the latest version, or null), openComments, updatedAt, picks ({ <versionNumber>: { <segmentId>: { source: media | gemini, jobId, device, at } } }: the owner's take per segment, made on any computer), renders (1.18.0: [{ renderId, versionNumber, file, sha256, bytes, picks: { segmentId: { source, jobId } }, notes, createdAt, device, state: in_review | approved | changes_requested, decisions: [{ id, kind, by, device, at, note }] }], newest first; get only), versions: [{ number, createdAt, title, loop, keyframes: [{ id, file, sha256, bytes, caption, parentKeyframeId }], segments: [{ id, fromKeyframeId, toKeyframeId, action, durationSeconds, model, settings, estimateUsd }], props: [{ id, name, kind, cells }], notes }], submissions: [{ versionNumber, at }], decisions: [...], comments: [{ id, versionNumber, target: { kind: storyboard } | { kind: keyframe, keyframeId, region ({ x, y, r } 0..1, a pin) or null } | { kind: segment, segmentId } | { kind: prop, propId, keyframeId }, author: owner | operator, device, text, createdAt, state: open | resolved, stateChangedAt, stateChangedBy, replies: [{ id, author, device, text, createdAt }] }] }.";

  storyboardWrite(
    "factory_storyboard_create",
    `Create a storyboard (1.16.0): the keyframes of a video loop, the segment of video between each two of them and a prop table, for the owner to review and approve BEFORE any video is generated. { channelId (connected here, with a workspace folder), storyboardId? (yours, 1-40 letters/digits/'_'/'-'; default sb_<random>), planId? (a generation plan it belongs to), title (<= 200), loop (true: the last keyframe goes back to the first), keyframes: [{ id (1-40 letters/digits/'_'/'-'), file (a path relative to the channel's '99 Data Exchange/': 'Sent to YTM/...' or a job's output in place, 'From YTM/gemini/<jobId>/...' or 'From YTM/media/<jobId>/...'), caption? (<= 200), parentKeyframeId? (another keyframe it was made from) }] (2-24, in order), segments: [{ id, fromKeyframeId, toKeyframeId, action (what happens; <= 4000), durationSeconds (> 0, <= 600), model? (<= 200), settings? ({ name: string | number | boolean }), estimateUsd? }] -- exactly one for each neighbouring pair K0->K1, K1->K2, ... and, with loop, the last back to the first; props?: [{ id, name (<= 200), kind: object | character, cells: { keyframeId: its state there (<= 200) } }] (<= 40), notes? (<= 4000), videoNumber? (1.20.0: the channel's video it is for, e.g. 'V49' from factory_video_create; jobs of its segments take it) } -> { storyboard } (version 1, state draft). Each file must exist in the channel's exchange folders on this computer; its sha256 and size are frozen in the version. Keep a version's files unchanged once it uses them: write a new version's images to a new folder (e.g. bar/v2/). Nothing is generated or charged. Refusals: validation_failed (details.field and the id), storyboard_file_unavailable (details.keyframeId, reason), storyboard_channel_unavailable, video_not_found / video_in_dispute (videoNumber). ${STORYBOARD_SHAPE}`,
    z.object({ channelId: z.string(), storyboardId: z.string().optional(), planId: z.string().nullable().optional(), videoNumber: z.string().nullable().optional(), ...storyboardContent }).strict(),
    (input) => deps.storyboards.create(input)
  );
  storyboardWrite(
    "factory_storyboard_update",
    "Change a storyboard (1.16.0): { channelId, storyboardId, and the whole content again as in factory_storyboard_create (title, loop, keyframes, segments, props?, notes?) } -> { storyboard, changed, versionNumber }. A content change -- a text, a cell, a keyframe file, or a file's bytes -- makes the next version (v2, v3, ...); the same content again changes nothing (changed: false). Older versions stay readable with their comments. A new version is not approved: it is a draft until you submit it, so an approval never carries over to edited content. Refusals: as factory_storyboard_create, and storyboard_not_found. BL-194 (1.20.0): videoNumber? -- a video of the channel ('V49') or null to remove it, absent keeps it; changing it makes no new version.",
    z.object({ channelId: z.string(), storyboardId: z.string(), videoNumber: z.string().nullable().optional(), ...storyboardContent }).strict(),
    (input) => deps.storyboards.update(input)
  );
  storyboardWrite(
    "factory_storyboard_submit",
    "Put the latest version of a storyboard in the owner's review (1.16.0): { channelId, storyboardId } -> { storyboard, alreadySubmitted }. The state becomes in_review and the owner sees it in Media. Submitting the same version again changes nothing. The owner then comments (on the storyboard, a keyframe with a pin, a segment or a prop cell) and requests changes or approves -- in the Web UI only, on the latest version only. Refusals: storyboard_not_found, storyboard_channel_unavailable.",
    storyboardRef,
    (input) => deps.storyboards.submit(input)
  );
  storyboardWrite(
    "factory_storyboard_reply",
    "Answer an owner's comment on a storyboard and/or resolve it (1.16.0): { channelId, storyboardId, commentId, text? (<= 4000; your reply in its thread), resolve? (true: resolved, false: open again) } (text or resolve required) -> { storyboard, replyId (or null) }. Refusals: storyboard_not_found, storyboard_comment_not_found, validation_failed.",
    z.object({ channelId: z.string(), storyboardId: z.string(), commentId: z.string(), text: z.string().optional(), resolve: z.boolean().optional() }).strict(),
    (input) => deps.storyboards.reply(input)
  );
  storyboardWrite(
    "factory_storyboard_attach_render",
    "Attach your final file of a storyboard version for the owner's verdict (1.18.0; FO-REQ-0025 B): { channelId, storyboardId, versionNumber (the APPROVED LATEST version), file (a video -- .mp4, .mov, .m4v, .webm -- relative to the channel's '99 Data Exchange/': 'Sent to YTM/...' or a job's output 'From YTM/media/<jobId>/...' / 'From YTM/gemini/<jobId>/...'; on this computer), picks? ({ <segmentId>: { source: media | gemini, jobId } }: the take of each segment the file uses -- each a take of exactly that segment and version, made on any computer; omitted: the owner's current picks of that version are recorded), notes? (<= 4000) } -> { storyboard, renderId }. The file's sha256 and size are frozen; keep it unchanged afterwards (a re-render goes to a new file and a new attach). Each call adds a render; none is edited. The owner plays it under «Ролик целиком» on either computer and approves it or requests changes; read the verdict in factory_storyboard_get's renders[].state and decisions. Nothing is generated or charged. Refusals: storyboard_not_approved (details.reason not_approved, state, latestVersion), storyboard_not_found, storyboard_file_unavailable (details.reason), storyboard_channel_unavailable, validation_failed (details.field: file | picks, with segmentId).",
    z.object({ channelId: z.string(), storyboardId: z.string(), versionNumber: z.number(), file: z.string(), picks: z.record(z.string(), z.object({}).passthrough()).optional(), notes: z.string().nullable().optional() }).strict(),
    (input) => deps.storyboards.attachRender(input)
  );
  const storyboardListInput = z.object({ channelId: z.string(), state: z.enum(["draft", "in_review", "changes_requested", "approved"]).optional() }).strict();
  registerTool(
    "factory_storyboard_get",
    { description: `One storyboard with every version, the owner's comments (with pins and threads), submissions and decisions (1.16.0): { channelId, storyboardId } -> { storyboard }. The storyboards are synced between the computers, so comments and decisions made on another computer appear here after a sync (a minute or two). Read-only. ${STORYBOARD_SHAPE}`, inputSchema: storyboardRef },
    async (args) => successResult(await deps.storyboards.get(parseInput(storyboardRef, args)))
  );
  registerTool(
    "factory_storyboard_list",
    {
      description:
        "A channel's storyboards, newest activity first (1.16.0): { channelId, state? } -> { storyboards: [the storyboard's summary fields, without versions, submissions, decisions and comments] }. state: draft (not submitted yet), in_review (waiting for the owner), changes_requested (read the open comments with factory_storyboard_get, then factory_storyboard_update and factory_storyboard_submit), approved (the latest version may be rendered). Read-only.",
      inputSchema: storyboardListInput,
    },
    async (args) => successResult(await deps.storyboards.list(parseInput(storyboardListInput, args)))
  );

  // -- BL-194 (VIDEO_COST_PLAN.md §2 stage 1, ADR 0040): video numbers. The video-projects module checks every bound and rule.
  const VIDEO_SHAPE =
    "Video: { channelId, video ('V49'), number (49), workingTitle, state: in_work | packaged (Vn_release.json, or an upload under way) | published (Vn_youtube.json, the registry, or a finished upload) | cancelled, sources: [reservation | folder | registry | upload], folder (the MMDD Vn folder relative to the workspace, once made) , createdAt / deviceId / hostName / thisComputer (the reservation: when and on which computer; null for a video known only from the workspace or uploads), conflict: null | { reservations: [{ deviceId, hostName, thisComputer, reservedAt, workingTitle, state, replacedBy }] (the winner first), winnerDeviceId, thisComputerInvolved, thisComputerLoses, suggestedVideo } }.";
  const videoCreateInput = z.object({ channelId: z.string().min(1).max(64), workingTitle: z.string().max(200).nullable().optional() }).strict();
  const videoListInput = z.object({ channelId: z.string().min(1).max(64), state: z.enum(["in_work", "packaged", "published", "cancelled"]).optional() }).strict();
  registerTool(
    "factory_video_create",
    {
      description: `Start a new video and get its number (1.20.0): { channelId (connected here, with a readable workspace folder), workingTitle? (<= 200) } -> { video }. The number is one above the highest Vn of the channel known from every source: the MMDD Vn folders in '04 Videos', video_registry.csv, this computer's uploads and the numbers every computer reserved (cancelled ones included -- a number is never given twice). Use it for the video's MMDD Vn folder (the date part is still set when it is published) and pass it as videoNumber to jobs, storyboards and plans. The number is reserved on this computer and reaches the others by sync (a minute or two): if another computer gave out the same number meanwhile, factory_video_list shows a conflict on both; the earlier reservation keeps it and the owner moves the other to the next number in the Web UI -- nothing is renumbered by itself and nothing can be linked to the number until then (video_in_dispute). Nothing is generated, charged or sent to YouTube. Refusals: video_workspace_unavailable (the channel is not connected here, or its workspace folder cannot be read -- no number is given then), validation_failed. ${VIDEO_SHAPE}`,
      inputSchema: videoCreateInput,
    },
    async (args) => {
      const input = parseInput(videoCreateInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.videos.create(input));
    }
  );
  registerTool(
    "factory_video_list",
    {
      description: `A channel's videos by number, highest first (1.20.0): { channelId, state? } -> { channelId, videos: [video], workspace: ok | not_configured | unavailable (without a readable workspace the folders and the registry are missing from the list), nextVideo (what factory_video_create would give now; null without a readable workspace) }. Every computer's reservations (about 1-2 minutes behind), the workspace's MMDD Vn folders (an empty one included), video_registry.csv and this computer's uploads. Read-only, local. ${VIDEO_SHAPE}`,
      inputSchema: videoListInput,
    },
    async (args) => successResult(await deps.videos.list(parseInput(videoListInput, args)))
  );
  const videoCostInput = z.object({ channelId: z.string().min(1).max(64), video: z.string().regex(/^V[1-9][0-9]{0,5}$/) }).strict();
  registerTool(
    "factory_video_get_cost",
    {
      description:
        "The visual cost of one video (1.20.0, BL-194 stage 3): { channelId (connected here), video ('V49') } -> { channelId, video, totals: { runpodUsd, geminiUsd, totalUsd, runs, estimated (true when any run's cost is not final) }, runs: [{ runId ('runpod:<jobId>' | 'gemini:<jobId>' | 'session:<sessionId>' -- a RunPod session that ran no job), source: runpod | gemini, kind: job | session, label (the template or the Gemini model), mediaKind, storyboardId, storyboardVersion, segmentId, planId, status: done | failed | cancelled | active, result: chosen (the owner's take of its storyboard segment, or a take a render uses) | rejected (another take of a segment) | failed | active | test (outside any storyboard segment) | session, usd, basis (RunPod: measured | estimated -- its share of the session's charge from ComfyUI's real GPU times or from estimated ones -- | pending, 0 while its session runs; Gemini: usage | price_table | not_charged | unknown_outcome | estimate while it runs), estimate, overheadUsd (RunPod: the part of the share that is pod start / idle time), gpuSeconds, createdAt, finishedAt, deviceId, hostName, thisComputer }] (newest first), computers: [{ deviceId, hostName, thisComputer, updatedAt (of its report; null for this computer) }] }. Every RunPod and Gemini run linked to the video on every computer (the others' about 1-2 minutes behind): a RunPod session's charge is split across its jobs in proportion to their GPU seconds, so the jobs add up to the charge. The same figure is written to Vn_cost.json next to Vn_release.json when the video is uploaded. Refusals: video_costs_unavailable (the channel is not connected here), validation_failed. Read-only, local; no prompt, path or key.",
      inputSchema: videoCostInput,
    },
    async (args) => successResult(await deps.videos.cost(parseInput(videoCostInput, args)))
  );

  // -- BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.7): every computer's media jobs, read-only.
  const jobsListInput = z
    .object({
      channelId: z.string().min(1).max(64).optional(),
      source: z.enum(["runpod", "gemini"]).optional(),
      mediaKind: z.enum(["audio", "image", "video"]).optional(),
      status: z.string().regex(/^[a-z_]{1,32}$/).optional(),
      planId: z.string().min(1).max(80).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict();
  registerTool(
    "factory_jobs_list",
    {
      description:
        "Every computer's media jobs in one list (1.17.0): this computer's and the ones other computers report (about 1-2 minutes behind) -- RunPod/ComfyUI jobs and Gemini jobs. { channelId?, source?: runpod | gemini, mediaKind?: audio | image | video, status? (runpod: queued | submitted | generating | done | failed | cancelled; gemini: queued | submitting | running | done | failed), planId?, limit? (1-500, default 100) } -> { devices: [{ deviceId, hostName, thisComputer, updatedAt, reportAgeSeconds, stale (no report for over 5 minutes) }], jobs: [{ jobId, source, channelId, mediaKind, status, createdBy, label (template and version, or the Gemini model), sessionId, progress, plan: { planId, itemKey, seed } | null, storyboard: { storyboardId, versionNumber, segmentId } | null, costUsd (Gemini; null for RunPod), costIsEstimate, errorCode, createdAt, submittedAt, finishedAt, outputs (paths relative to the channel's 99 Data Exchange/), device: { deviceId, hostName, thisComputer }, reportAgeSeconds, stale }] (newest first), total, truncated }. Unfinished jobs and jobs finished in the last 7 days. Codes only: never a prompt, parameters, input paths or a provider's error text (read this computer's own job in full with factory_media_get_job / factory_gemini_get_job). Another computer's job is shown, not controlled: its own computer runs, cancels and charges it. Read-only, local.",
      inputSchema: jobsListInput,
    },
    async (args) => successResult(await deps.jobs.list(parseInput(jobsListInput, args)))
  );

  // -- BL-220 (RESTART_WHEN_IDLE_PLAN.md, ADR 0049): restart when idle. The module checks every bound itself (validation_failed).
  const RESTART_SHAPE =
    "Status: { request: { id, status: open | restarting, requestedBy: owner | developer, requestedAt, ... } | null, waitingFor: [{ kind: media_session | media_job | gemini_job | upload | live_stream | operation_lock | operation | batch | hold | mcp_quiet | check_failed, count, ids (at most 5), until (when it ends by itself, or null) }], holds: [{ holdId, heldBy: factory | owner | worker:<channelId>, reason, createdAt, until, active }], lastRestart: { finishedAt, fromVersion, toVersion, fromSchema, toSchema, waitedMinutes, requestedBy } | null, quietMinutes (1-30, default 3), serviceMode }.";
  const holdRestartInput = z.object({ minutes: z.number(), reason: z.string() }).strict();
  const releaseHoldInput = z.object({ holdId: z.string() }).strict();
  registerTool(
    "factory_restart_status",
    {
      description: `Restart when idle on this computer (1.30.0): {} -> status. While a request is open (the owner's button, or the developer's script) the server checks every 15 s and restarts itself (a graceful stop; the system service starts the new build) once waitingFor is empty: no unfinished media session, no media job queued/submitted/generating/transferring, no Gemini job queued/submitting/running, no upload being sent, no live stream starting/stopping/switching (a running stream does not count), no operation lock or running operation/Batch, no active hold, and no MCP call in the last quietMinutes. A request still open after 24 h expires. This call itself does not count as an MCP call for the quiet window, so polling it never delays a restart. Read-only, local. ${RESTART_SHAPE}`,
      inputSchema: emptyInput,
    },
    async () => successResult(await deps.restart.status())
  );
  registerTool(
    "factory_hold_restart",
    {
      description:
        "Keep this computer's server from restarting while you work (1.30.0): { minutes (whole, 1-60), reason (1-200 characters) } -> { hold: { holdId, heldBy: factory, reason, createdAt, until, active } }. The hold ends by itself at `until`, or earlier with factory_release_hold; several holds can be active at once, and the owner can end any of them. Use it before a long step that must not be cut (for example a run you start and then watch). It only delays a restart; it never starts one. Refusals: validation_failed (minutes outside 1-60, no reason). Local only.",
      inputSchema: holdRestartInput,
    },
    async (args) => {
      const input = parseInput(holdRestartInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.restart.hold(input));
    }
  );
  registerTool(
    "factory_release_hold",
    {
      description:
        "End one of your own restart holds early (1.30.0): { holdId } -> { hold, released (false when it had already ended) }. A hold set by someone else (a channel worker, the owner) is not_found. Local only.",
      inputSchema: releaseHoldInput,
    },
    async (args) => {
      const input = parseInput(releaseHoldInput, args);
      await deps.assertMutationAllowed();
      return successResult(await deps.restart.release(input));
    }
  );

  return server;
}
