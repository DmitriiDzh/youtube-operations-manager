import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAnalyticsCore } from "@/lib/analytics";
import { DomainError } from "@/lib/analytics/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAnalyticsCore();

// Phase 8 (BL-054, docs/roadmap/plans/PHASE_8_PLAN.md §10 items 3-5) -- called once per dashboard
// mount (src/app/dashboard/page.tsx), regardless of which tab is active ("при входе в наш
// дашборд", the owner's own words), not on a repeating interval. A real mutation when (and only
// when) it decides to actually collect -- `runAutoCollectionIfStale` marks the per-channel
// timestamp BEFORE running, so this route's own gating by src/proxy.ts (like any other mutating
// POST) is a secondary safety net, not the mechanism that prevents double-collection between
// concurrent callers -- that's the service's own mark-then-run ordering.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId } = await params;
    const result = await core.runAutoCollectionIfStale({
      credentialRef: { userId: session.user.id },
      channelId,
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
