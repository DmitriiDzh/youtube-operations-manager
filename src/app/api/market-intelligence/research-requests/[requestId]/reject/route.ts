import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createMarketIntelligenceCore();

// Phase 9 slice 9G, part B -- the Web-UI-only counterpart to .../approve. See that route's own doc
// comment for the approval-integrity discipline both share.
export async function POST(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
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
    // handled here rather than destructured directly (found by independent code review on other
    // market-intelligence routes -- the same fix applied here from the start).
    const bodyRecord = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

    const { requestId } = await params;
    const result = await core.rejectMarketResearchRequest({ requestId, reason: bodyRecord.reason });
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
