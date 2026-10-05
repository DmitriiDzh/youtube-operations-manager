import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { runAllSyncFamiliesOnce } from "@/lib/sync-gateway";

// Device-wide, like src/app/api/device-handoff/**: every channelId synced here is determined
// server-side (`listStoredChannels()` -- every channel this device already knows about), never
// taken from client input, so there is no forged-channelId surface for
// docs/DEVELOPMENT_PLAYBOOK.md §6.6(b)'s active-channel check to guard against, unlike a route
// that takes `channelId` as a path/body parameter.

/**
 * Triggers one real sync cycle for EVERY document family this device knows about
 * (`runAllSyncFamiliesOnce`, shared with the server-side scheduler, DEVICE_AUTO_SYNC_PLAN.md §3.5).
 * Gated by `src/proxy.ts`'s device-availability mutation lock like any other real mutation (this
 * route is not in its exempt list) -- a sync cycle genuinely writes local `.automerge` files.
 */
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { changeDrafts, editorialProfile, aiConnections } = await runAllSyncFamiliesOnce();

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
