import { recordSyncFamilyResult, type SyncFamily } from "@/lib/db";
import { createChangeDraftsSyncCoreForProduction } from "./change-drafts-sync";
import { createEditorialProfileSyncRunnerForProduction } from "./editorial-profile-sync";
import { createAiConnectionsCatalogSyncRunnerForProduction } from "./ai-connections-catalog-sync";
import { createMediaSessionsSyncRunnerForProduction } from "./media-sessions-sync";
import { createLiveStreamsSyncRunnerForProduction } from "./live-streams-sync";
import { createGenerationPlansSyncRunnerForProduction } from "./generation-plans-sync";
import { createMediaSettingsSyncRunnerForProduction } from "./media-settings-sync";
import { createAgentTokensSyncRunnerForProduction } from "./agent-tokens-sync";
import { createChannelLanguageSettingsSyncRunnerForProduction } from "./channel-language-settings-sync";
import { createChannelPublishingSettingsSyncRunnerForProduction } from "./channel-publishing-settings-sync";
import { createPublishingUploadsSyncRunnerForProduction } from "./publishing-uploads-sync";
import { createStoryboardsSyncRunnerForProduction } from "./storyboards-sync";
import { createMediaJobsSyncRunnerForProduction } from "./media-jobs-sync";
import { createVideoReservationsSyncRunnerForProduction } from "./video-reservations-sync";
import { createVideoCostsSyncRunnerForProduction } from "./video-costs-sync";
import { createGeminiSpendSyncRunnerForProduction } from "./gemini-spend-sync";
import { createGeminiSettingsSyncRunnerForProduction } from "./gemini-settings-sync";

/** Runs one family's cycle and unconditionally records its outcome to `sync_family_status`
 * (2026-09-23, Merge-tab redesign) -- regardless of whether it resolved or threw, so the
 * persistent status the Merge tab reads never goes stale just because one family had a bad
 * cycle. Isolates a thrown error to this one family: a bootstrap-config read failure in the
 * editorial-profile runner, say, must never prevent change-drafts or ai-connections from
 * syncing and having their own outcome recorded. */
async function runAndRecord<T>(
  family: SyncFamily,
  run: () => Promise<T>
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    const result = await run();
    await recordSyncFamilyResult(family, { ok: true, error: null });
    return { ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await recordSyncFamilyResult(family, { ok: false, error: message });
    return { ok: false, error: message };
  }
}

/**
 * One real sync cycle for EVERY document family this device knows about
 * (`docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4). Shared by the "Sync now" route
 * (`POST /api/change-drafts/sync`) and the server-side scheduler (DEVICE_AUTO_SYNC_PLAN.md §3.5),
 * so drafts sync even with no browser tab open. Mutual exclusion between those callers is the
 * process-wide guard in `runAllSyncFamiliesOnce` below.
 */
async function runAllOnce() {
  const [changeDrafts, editorialProfile, aiConnections, mediaSessions, generationPlans, mediaSettings, agentTokens, liveStreams, channelLanguageSettings, channelPublishingSettings, publishingUploads, storyboards, mediaJobs, geminiSpend, geminiSettings, videoReservations, videoCosts] = await Promise.all([
    runAndRecord("change_drafts", () => createChangeDraftsSyncCoreForProduction().runSyncCycle()),
    runAndRecord("editorial_profile", () => createEditorialProfileSyncRunnerForProduction().runSyncCycle()),
    runAndRecord("ai_connections", () => createAiConnectionsCatalogSyncRunnerForProduction().runSyncCycle()),
    // BL-138: this device's RunPod sessions report out, the other devices' reports in.
    runAndRecord("media_sessions", () => createMediaSessionsSyncRunnerForProduction().runSyncCycle()),
    // BL-143 phase 2: this device's generation plans (and its verdicts on others' plans) out, the other devices' in.
    runAndRecord("generation_plans", () => createGenerationPlansSyncRunnerForProduction().runSyncCycle()),
    // BL-150: the shared Servers → Setup settings (one Automerge document; media-generation applies it on its own tick).
    runAndRecord("media_settings", () => createMediaSettingsSyncRunnerForProduction().runSyncCycle()),
    // BL-160: the agent tokens this device knows (hashes only) out, the other devices' in; agent-token-sync applies them.
    runAndRecord("agent_tokens", () => createAgentTokensSyncRunnerForProduction().runSyncCycle()),
    // BL-176: this computer's live streams report out (the Mac hosts them), the other devices' in (shown read-only).
    runAndRecord("live_streams", () => createLiveStreamsSyncRunnerForProduction().runSyncCycle()),
    // BL-178 part B: each channel's language baseline and tracked languages, the same on every computer.
    runAndRecord("channel_language_settings", () => createChannelLanguageSettingsSyncRunnerForProduction().runSyncCycle()),
    // BL-182 stage 2: each channel's publishing defaults (time, playlist, category, status flags), the same on every computer.
    runAndRecord("channel_publishing_settings", () => createChannelPublishingSettingsSyncRunnerForProduction().runSyncCycle()),
    // BL-182 stage 2: this computer's uploads under way out, the other devices' in (a package one computer uploads is refused on the other).
    runAndRecord("publishing_uploads", () => createPublishingUploadsSyncRunnerForProduction().runSyncCycle()),
    // BL-184: each channel's storyboards (the Operator's versions, the owner's comments and decisions), the same on every computer.
    runAndRecord("storyboards", () => createStoryboardsSyncRunnerForProduction().runSyncCycle()),
    // BL-188: this computer's media jobs (RunPod and Gemini) out, the other devices' in -- one shared list everywhere.
    runAndRecord("media_jobs", () => createMediaJobsSyncRunnerForProduction().runSyncCycle()),
    // BL-193: this computer's Gemini spend (under its key's fingerprint) out, the other devices' in -- one spend per Gemini key.
    runAndRecord("gemini_spend", () => createGeminiSpendSyncRunnerForProduction().runSyncCycle()),
    // BL-193: the Gemini limits (one Automerge document; gemini-media applies it on its own tick).
    runAndRecord("gemini_settings", () => createGeminiSettingsSyncRunnerForProduction().runSyncCycle()),
    // BL-194 (ADR 0040): the video numbers this computer reserved out, the other devices' in (one list of videos everywhere).
    runAndRecord("video_reservations", () => createVideoReservationsSyncRunnerForProduction().runSyncCycle()),
    // BL-194 stage 3 (ADR 0041): this computer's paid runs out, the other devices' in (one cost per video everywhere).
    runAndRecord("video_costs", () => createVideoCostsSyncRunnerForProduction().runSyncCycle()),
  ]);
  return { changeDrafts, editorialProfile, aiConnections, mediaSessions, generationPlans, mediaSettings, agentTokens, liveStreams, channelLanguageSettings, channelPublishingSettings, publishingUploads, storyboards, mediaJobs, geminiSpend, geminiSettings, videoReservations, videoCosts };
}

type AllFamiliesResult = Awaited<ReturnType<typeof runAllOnce>>;
const IN_FLIGHT_KEY = Symbol.for("ytom.syncGateway.allFamiliesInFlight");
type GlobalWithInFlight = typeof globalThis & { [IN_FLIGHT_KEY]?: Promise<AllFamiliesResult> };

export async function runAllSyncFamiliesOnce(): Promise<AllFamiliesResult> {
  // Process-wide single flight, keyed on `globalThis`: Next.js compiles `instrumentation.ts` (the
  // scheduler) separately from route handlers, so a module-level guard alone might not be shared
  // between the two callers. A caller arriving mid-cycle joins the running cycle.
  const g = globalThis as GlobalWithInFlight;
  const existing = g[IN_FLIGHT_KEY];
  if (existing) return existing;
  const run = runAllOnce().finally(() => {
    if (g[IN_FLIGHT_KEY] === run) delete g[IN_FLIGHT_KEY];
  });
  g[IN_FLIGHT_KEY] = run;
  return run;
}
