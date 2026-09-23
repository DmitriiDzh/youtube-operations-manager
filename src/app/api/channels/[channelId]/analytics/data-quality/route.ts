import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAnalyticsCore } from "@/lib/analytics";
import { DomainError } from "@/lib/analytics/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createAnalyticsCore();

// Phase 8 follow-up, slice 2 (docs/roadmap/FUTURE_PHASES.md §4, "data-quality/missing-data
// diagnostics"). Pure local read (no YouTube call) over analytics_collection_runs -- never gated
// by src/proxy.ts's mutation check, since GET is never a mutating method.
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

    const result = await core.getDataQualityReport({
      credentialRef: { userId: session.user.id },
      channelId,
      startDate,
      endDate,
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
