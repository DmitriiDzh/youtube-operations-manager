import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import {
  createAiConnectionsCatalogSyncRunnerForProduction,
  createChangeDraftsSyncCoreForProduction,
  createEditorialProfileSyncRunnerForProduction,
} from "@/lib/sync-gateway";

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
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [result, editorialProfile, aiConnections] = await Promise.all([
      changeDraftsCore.runSyncCycle(),
      editorialProfileRunner.runSyncCycle(),
      aiConnectionsRunner.runSyncCycle(),
    ]);
    return NextResponse.json({ ...result, editorialProfile, aiConnections });
  } catch (error) {
    return NextResponse.json(
      { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
