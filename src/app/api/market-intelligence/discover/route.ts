import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createMarketIntelligenceCore();

// Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md §6) -- the one search.list-based
// discovery action, only ever called from an explicit operator UI click (owner decision 4: "По
// запросу из UI пользователем" -- never automatic, never scheduled). A real mutation (writes
// candidate rows and a run-log row even on a "zero new candidates" outcome), gated by
// src/proxy.ts normally, never exempted.
export async function POST(request: Request) {
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
    // handled here rather than destructured directly (same fix applied to the other market-
    // intelligence routes -- found by independent code review).
    const bodyRecord = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

    const result = await core.discoverChannels(
      { query: bodyRecord.query, credentialRef: { userId: session.user.id } },
      { createdVia: "web_ui" }
    );
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
