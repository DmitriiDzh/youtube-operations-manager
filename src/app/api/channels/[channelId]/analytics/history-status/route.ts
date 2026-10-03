import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAnalyticsCore } from "@/lib/analytics";
import { DomainError } from "@/lib/analytics/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAnalyticsCore();

// BL-120 -- how much earlier history the automatic catch-up (BL-118) still has to collect: videos whose early days are missing and whether the
// channel-level totals have a gap. A LOCAL read of what is already stored (no YouTube call, no quota); whether the catch-up is running right now is
// answered by GET /api/operations?kind=analytics-backfill. Never gated by src/proxy.ts's mutation check (GET).
export async function GET(_request: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId } = await params;
    const plan = await core.getHistoryCatchUpPlan({ credentialRef: { userId: session.user.id }, channelId });
    return NextResponse.json({ remainingVideos: plan.videoRanges.length, hasChannelGap: plan.channelRange !== null });
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json(
        { error: error.code, message: error.message, details: error.details },
        { status: getVideoMetadataErrorStatus(error.code) }
      );
    }
    return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
