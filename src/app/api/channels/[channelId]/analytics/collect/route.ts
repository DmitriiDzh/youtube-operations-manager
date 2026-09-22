import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAnalyticsCore } from "@/lib/analytics";
import { DomainError } from "@/lib/analytics/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAnalyticsCore();

// Phase 8 (BL-053, docs/roadmap/plans/PHASE_8_PLAN.md §6 slice 4) -- the manual "collect now"
// trigger. A real, local-state mutation (writes video_metrics_daily rows), gated normally by
// src/proxy.ts's blanket device-availability check like any other POST route -- deliberately NOT
// added to that file's read-only exemption list, unlike e.g. ai-localization's `generate` route.
//
// No `channelAccess.assertActiveChannel` call here: `core.collectMetrics` already does it itself
// (mirrors channel-sync/services.ts's `listSyncedVideos`, since this service, like that one,
// already receives `credentialRef` -- see src/lib/analytics/services.ts's own doc comment).
// Adding a second check here would duplicate, not add, safety.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId } = await params;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: "validation_failed", message: "Request body must be valid JSON" },
        { status: 400 }
      );
    }

    const result = await core.collectMetrics({
      ...body,
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
