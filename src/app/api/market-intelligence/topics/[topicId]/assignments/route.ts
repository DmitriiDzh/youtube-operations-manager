import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createMarketIntelligenceCore();

export async function GET(_request: Request, { params }: { params: Promise<{ topicId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { topicId } = await params;
    const result = await core.listAssignmentsForTopic({ topicId });
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

// A channel subject must already be on the watchlist; a video subject's format is validated by the
// schema layer. Rejects an exact-duplicate (topic, subject) pair before insert.
export async function POST(request: Request, { params }: { params: Promise<{ topicId: string }> }) {
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
    // handled here rather than destructured directly (found by independent code review -- an
    // earlier version threw a raw TypeError on `body.subjectType` for exactly this input, which the
    // generic catch below turned into an unhelpful internal_error/500 instead of validation_failed).
    const bodyRecord = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

    const { topicId } = await params;
    const assignment = await core.assignTopic(
      { topicId, subjectType: bodyRecord.subjectType, subjectId: bodyRecord.subjectId },
      { createdVia: "web_ui" }
    );
    return NextResponse.json({ assignment }, { status: 201 });
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
