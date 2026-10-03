import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createReachReportsCore } from "@/lib/reach-reports";
import { DomainError } from "@/lib/reach-reports/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createReachReportsCore();

// BL-114 -- thumbnail impressions / CTR from the YouTube Reporting API (ADR 0014). A LOCAL read of what
// the sync route has already imported: no Google call here, and it works while "Reporting reads" is off.
// `state` says whether an empty result means "no job", "job created, no file yet" or real data -- an empty
// list is never zero impressions. Never gated by src/proxy.ts's mutation check (GET).
export async function GET(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId } = await params;
    const url = new URL(request.url);
    const result = await core.getChannelReach({
      credentialRef: { userId: session.user.id },
      channelId,
      startDate: url.searchParams.get("startDate"),
      endDate: url.searchParams.get("endDate"),
      // BL-120: one video, and/or the stored rows per video per day (the per-video impressions/CTR drill-down).
      ...(url.searchParams.get("videoId") ? { videoId: url.searchParams.get("videoId") } : {}),
      ...(url.searchParams.get("groupBy") ? { groupBy: url.searchParams.get("groupBy") } : {}),
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
