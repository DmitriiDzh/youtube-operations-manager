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

    // BL-145: `mode: "genre"` searches music videos and groups them by channel (optionally `publishedWithinDays`);
    // anything else is the original search by channel name.
    if (bodyRecord.mode === "genre") {
      const result = await core.discoverChannelsByGenre(
        {
          query: bodyRecord.query,
          ...(bodyRecord.publishedWithinDays !== undefined && bodyRecord.publishedWithinDays !== null ? { publishedWithinDays: bodyRecord.publishedWithinDays } : {}),
          credentialRef: { userId: session.user.id },
        },
        { createdVia: "web_ui" }
      );
      return NextResponse.json({ mode: "genre", ...result });
    }
    const result = await core.discoverChannels(
      { query: bodyRecord.query, credentialRef: { userId: session.user.id } },
      { createdVia: "web_ui" }
    );
    return NextResponse.json({ mode: "channels", ...result });
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

// Phase 13 slice 13.4 -- read-only: how many of YouTube's daily searches (own bucket) are used today.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await core.getSearchUsage());
}
