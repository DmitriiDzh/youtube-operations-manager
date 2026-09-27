import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createMarketIntelligenceCore();

// Phase 9 slice 9E, part B -- changes a trend candidate's lifecycle status. Requires a `reason`
// (schema-enforced); the service layer writes it as a signal evidence row in the same action, so a
// status can never move without a corresponding evidence trail.
export async function PATCH(request: Request, { params }: { params: Promise<{ trendCandidateId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }

    const { trendCandidateId } = await params;
    const trendCandidate = await core.updateTrendCandidateStatus(
      { trendCandidateId, status: body.status, reason: body.reason },
      { createdVia: "web_ui" }
    );
    return NextResponse.json({ trendCandidate });
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
