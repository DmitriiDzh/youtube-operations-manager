import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createMarketIntelligenceCore();

export async function GET(_request: Request, { params }: { params: Promise<{ trendCandidateId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { trendCandidateId } = await params;
    const result = await core.listTrendEvidence({ trendCandidateId });
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

// Records an additional observation against an existing trend candidate without changing its
// status (e.g. another supporting channel/video, or a plain signal note).
export async function POST(request: Request, { params }: { params: Promise<{ trendCandidateId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }
    // A well-formed-but-non-object body (e.g. a literal `null`) parses fine as JSON, so it must be
    // handled here rather than destructured directly (found by independent code review).
    const bodyRecord = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

    const { trendCandidateId } = await params;
    const evidence = await core.recordTrendEvidence(
      { trendCandidateId, evidenceType: bodyRecord.evidenceType, referenceId: bodyRecord.referenceId, description: bodyRecord.description },
      { createdVia: "web_ui" }
    );
    return NextResponse.json({ evidence }, { status: 201 });
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
