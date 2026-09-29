import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createMarketIntelligenceCore();

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
    const result = await core.runCollectionIfStale({ credentialRef: { userId: session.user.id } });
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
