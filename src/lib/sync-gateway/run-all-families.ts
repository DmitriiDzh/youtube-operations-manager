import { recordSyncFamilyResult, type SyncFamily } from "@/lib/db";
import { createChangeDraftsSyncCoreForProduction } from "./change-drafts-sync";
import { createEditorialProfileSyncRunnerForProduction } from "./editorial-profile-sync";
import { createAiConnectionsCatalogSyncRunnerForProduction } from "./ai-connections-catalog-sync";
import { createMediaSessionsSyncRunnerForProduction } from "./media-sessions-sync";
import { createGenerationPlansSyncRunnerForProduction } from "./generation-plans-sync";
import { createMediaSettingsSyncRunnerForProduction } from "./media-settings-sync";

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
  const [changeDrafts, editorialProfile, aiConnections, mediaSessions, generationPlans, mediaSettings] = await Promise.all([
    runAndRecord("change_drafts", () => createChangeDraftsSyncCoreForProduction().runSyncCycle()),
    runAndRecord("editorial_profile", () => createEditorialProfileSyncRunnerForProduction().runSyncCycle()),
    runAndRecord("ai_connections", () => createAiConnectionsCatalogSyncRunnerForProduction().runSyncCycle()),
    // BL-138: this device's RunPod sessions report out, the other devices' reports in.
    runAndRecord("media_sessions", () => createMediaSessionsSyncRunnerForProduction().runSyncCycle()),
    // BL-143 phase 2: this device's generation plans (and its verdicts on others' plans) out, the other devices' in.
    runAndRecord("generation_plans", () => createGenerationPlansSyncRunnerForProduction().runSyncCycle()),
    // BL-150: the shared Servers → Setup settings (one Automerge document; media-generation applies it on its own tick).
    runAndRecord("media_settings", () => createMediaSettingsSyncRunnerForProduction().runSyncCycle()),
  ]);
  return { changeDrafts, editorialProfile, aiConnections, mediaSessions, generationPlans, mediaSettings };
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
