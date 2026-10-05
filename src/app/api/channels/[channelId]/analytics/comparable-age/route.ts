import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAnalyticsCore } from "@/lib/analytics";
import { DomainError } from "@/lib/analytics/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAnalyticsCore();

// Phase 8 follow-up, slice 3 (docs/roadmap/FUTURE_PHASES.md §4, "comparing videos at comparable
// ages"). Pure local read (no YouTube call) over already-collected video_metrics_daily rows --
// never gated by src/proxy.ts's mutation check, since GET is never a mutating method.
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
    const videoIdsRaw = url.searchParams.get("videoIds");
    const videoIds = videoIdsRaw
      ? videoIdsRaw.split(",").map((entry) => entry.trim()).filter(Boolean)
      : [];
    const metricName = url.searchParams.get("metricName") ?? undefined;
    const maxDaysRaw = url.searchParams.get("maxDays");
    const maxDays = maxDaysRaw !== null ? Number(maxDaysRaw) : undefined;

    const result = await core.getComparableAgeComparison({
      credentialRef: { userId: session.user.id },
      channelId,
      videoIds,
      metricName,
      maxDays,
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
