import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import {
  createAiConnectionsCatalogSyncRunnerForProduction,
  createChangeDraftsSyncCoreForProduction,
  createEditorialProfileSyncRunnerForProduction,
} from "@/lib/sync-gateway";
import { recordSyncFamilyResult, type SyncFamily } from "@/lib/db";

// Device-wide, like src/app/api/device-handoff/**: every channelId synced here is determined
// server-side (`listStoredChannels()` -- every channel this device already knows about), never
// taken from client input, so there is no forged-channelId surface for
// docs/DEVELOPMENT_PLAYBOOK.md §6.6(b)'s active-channel check to guard against, unlike a route
// that takes `channelId` as a path/body parameter.
//
// Module-scope, not constructed per request (matches `src/app/api/device-handoff/shared.ts`'s
// own `bootstrapConfigStore`): both production factories are themselves memoized, but binding
// them here too keeps this file's own intent explicit -- each core's `runSyncCycle` single-flight
// guard only works if every caller shares the same instance.
const changeDraftsCore = createChangeDraftsSyncCoreForProduction();
const editorialProfileRunner = createEditorialProfileSyncRunnerForProduction();
const aiConnectionsRunner = createAiConnectionsCatalogSyncRunnerForProduction();

/**
 * Triggers one real sync cycle for EVERY document family this device knows about
 * (`docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4 -- one "Sync now" action covers
 * the whole sync gateway, even though each family runs its own independent, isolated cycle
 * underneath). Today: the draft layer (`change_sets`/`changes`, CD5), the editorial-profile
 * catalog, and the ai-connections-catalog (both M3) -- a future family is added here the same
 * way, without touching any existing cycle. Gated by `src/proxy.ts`'s device-availability mutation lock like any other real mutation
 * (this route is not in its exempt list) -- a sync cycle genuinely writes local `.automerge`
 * files, so pausing it during an unresolved device-handoff/recovery state is the same
 * conservative default every other write path in this app already gets.
 */
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

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [changeDrafts, editorialProfile, aiConnections] = await Promise.all([
    runAndRecord("change_drafts", () => changeDraftsCore.runSyncCycle()),
    runAndRecord("editorial_profile", () => editorialProfileRunner.runSyncCycle()),
    runAndRecord("ai_connections", () => aiConnectionsRunner.runSyncCycle()),
  ]);

  const body = {
    ...(changeDrafts.ok ? changeDrafts.result : { error: changeDrafts.error }),
    editorialProfile: editorialProfile.ok ? editorialProfile.result : { error: editorialProfile.error },
    aiConnections: aiConnections.ok ? aiConnections.result : { error: aiConnections.error },
  };

  // 207 (Multi-Status) when at least one family's cycle threw outright -- distinct from a
  // per-channel pushError/peersSkipped inside an otherwise-successful cycle, which stays a 200
  // exactly as before (those are already isolated and surfaced in the cycle's own result).
  const anyFailed = !changeDrafts.ok || !editorialProfile.ok || !aiConnections.ok;
  return NextResponse.json(body, { status: anyFailed ? 207 : 200 });
}
