import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChangeDraftsSyncCoreForProduction } from "@/lib/change-drafts-sync";

// Device-wide, like src/app/api/device-handoff/**: every channelId synced here is determined
// server-side (`listStoredChannels()` -- every channel this device already knows about), never
// taken from client input, so there is no forged-channelId surface for
// docs/DEVELOPMENT_PLAYBOOK.md §6.6(b)'s active-channel check to guard against, unlike a route
// that takes `channelId` as a path/body parameter.
//
// Module-scope, not constructed per request (matches `src/app/api/device-handoff/shared.ts`'s
// own `bootstrapConfigStore`): `createChangeDraftsSyncCoreForProduction()` is itself memoized
// (`change-drafts-sync/index.ts`), but binding it here too keeps this file's own intent explicit
// -- the `runSyncCycle` single-flight guard only works if every caller shares the same instance.
const core = createChangeDraftsSyncCoreForProduction();

/**
 * Triggers one real push+merge sync cycle (AUTOMERGE_MIGRATION_PLAN.md §6 CD5) across every
 * locally known channel. Gated by `src/proxy.ts`'s device-availability mutation lock like any
 * other real mutation (this route is not in its exempt list) -- a sync cycle genuinely writes
 * local `.automerge` files, so pausing it during an unresolved device-handoff/recovery state is
 * the same conservative default every other write path in this app already gets, not a special
 * case invented for this route.
 */
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await core.runSyncCycle();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
