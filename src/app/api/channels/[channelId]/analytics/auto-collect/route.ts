import { getServerSession } from "next-auth";
import { after, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAnalyticsCore } from "@/lib/analytics";
import { getOperationRegistry, runTrackedOperation } from "@/lib/operation-progress";
import { DomainError } from "@/lib/analytics/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAnalyticsCore();

// Phase 8 (BL-059, docs/roadmap/plans/PHASE_8_PLAN.md §10 items 3-5) -- called once per dashboard
// mount (src/app/(app)/layout.tsx, BL-149), regardless of which tab is active ("при входе в наш
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

    // BL-118 (owner decisions 2026-10-03): the automatic collection also closes the gap between the start of a channel's history and what
    // was collected (older days of every video, channel totals) -- once per missing range, never by hand. It runs AFTER this response (a
    // long job must not hold the dashboard), as a tracked operation so the server's idle shutdown sees it and a progress view can attach.
    let catchUpScheduled = false;
    try {
      const credentialRef = { userId: session.user.id };
      const plan = await core.getHistoryCatchUpPlan({ credentialRef, channelId });
      if (plan.videoRanges.length > 0 || plan.channelRange) {
        catchUpScheduled = true;
        after(async () => {
          try {
            await runTrackedOperation({
              registry: getOperationRegistry(),
              kind: "analytics-backfill",
              channelId,
              title: "Collecting earlier analytics history",
              cancellable: false,
              work: (progress) => core.runHistoryCatchUp({ credentialRef, channelId }, { progress }),
              messageFor: (done) => (done.ranCatchUp ? `${done.videosQueried} video(s) back-filled.` : "Nothing to back-fill."),
            });
          } catch {
            // Already running, reads switched off, quota reserve: the catch-up is planned again on the next dashboard open.
          }
        });
      }
    } catch {
      // Planning is best-effort: it never turns a successful rolling collection into an error.
    }

    return NextResponse.json({ ...result, catchUpScheduled });
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
