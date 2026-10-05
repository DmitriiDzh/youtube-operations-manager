import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { buildChannelOverviewView, createAnalyticsCore, type Granularity } from "@/lib/analytics";
import { DomainError } from "@/lib/analytics/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAnalyticsCore();

// Studio-Parity S6b (docs/roadmap/plans/STUDIO_PARITY_PLAN.md §4) -- the Analytics "Overview"
// tab's channel-level cards/chart. BL-120 (owner decision 2026-10-04): answers from the stored
// channel-level totals when they cover both periods (no quota, instant) and says so (`source`,
// `collectedAt`); `?refresh=1` forces a live Analytics API read. `?granularity=week|month` adds
// calendar buckets. The response also carries the channel's start date, whether the comparison period
// existed, and the first provisional day. Never gated by src/proxy.ts's mutation check (GET).
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
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");

    const requestedGranularity = url.searchParams.get("granularity") ?? "day";
    if (!["day", "week", "month"].includes(requestedGranularity)) {
      return NextResponse.json({ error: "validation_failed", message: "granularity must be day, week or month" }, { status: 400 });
    }
    const credentialRef = { userId: session.user.id };
    const [overview, channelStartDate] = await Promise.all([
      core.getChannelOverview({
        credentialRef,
        channelId,
        startDate,
        endDate,
        preferLocal: url.searchParams.get("refresh") !== "1",
      }),
      core.getChannelStartDate({ credentialRef, channelId }),
    ]);

    return NextResponse.json(
      buildChannelOverviewView({ overview, channelStartDate, granularity: requestedGranularity as Granularity, now: new Date() })
    );
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
