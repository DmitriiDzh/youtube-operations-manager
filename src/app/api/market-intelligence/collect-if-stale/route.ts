import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { getDeviceSyncRunner } from "@/lib/device-sync";
import { collectAfterDeviceSync } from "./sync-gate";

const core = createMarketIntelligenceCore();

/** An import holds the lock for about a second; a sync that takes longer than this is treated as
 * "not caught up yet" -- the next dashboard load tries again. */
const SYNC_FIRST_TIMEOUT_MS = 60_000;

function syncFirstWithTimeout() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ allowed: false; reason: string }>((resolve) => {
    timer = setTimeout(() => resolve({ allowed: false, reason: "device sync is still running" }), SYNC_FIRST_TIMEOUT_MS);
  });
  return Promise.race([getDeviceSyncRunner().syncBeforeBackgroundWrite(), timeout]).finally(() => clearTimeout(timer));
}

// Phase 9 slice 9B (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md §6) -- mirrors
// .../analytics/auto-collect's own shape/idempotence contract: called once per dashboard mount
// (src/app/dashboard/page.tsx), regardless of which tab is active ("во время запущенного
// интерфейса", owner decision 1), not on a repeating interval. A real mutation when (and only
// when) it decides to actually collect something -- runCollectionIfStale's own atomic claim
// (never a per-caller gate here) is what prevents two concurrent callers from double-spending the
// operator's own daily unit budget, not this route's gating by src/proxy.ts, which is a secondary
// safety net like every other real-mutation route in this app.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const userId = session.user.id;
    const result = await collectAfterDeviceSync({
      syncFirst: syncFirstWithTimeout,
      collect: () => core.runCollectionIfStale({ credentialRef: { userId } }),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json(
        { error: error.code, message: error.message, details: error.details },
        { status: getVideoMetadataErrorStatus(error.code) }
      );
    }

    return NextResponse.json(
      { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
