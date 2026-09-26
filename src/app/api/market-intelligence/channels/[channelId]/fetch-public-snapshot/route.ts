import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createMarketIntelligenceCore();

// Phase 9 slice 3 -- the one route in this module that triggers a real outbound YouTube API
// call. credentialRef is always the calling session's own identity here (never taken from the
// request body), same discipline as every other session-authenticated route in this codebase.
export async function POST(_request: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId } = await params;
    const evidence = await core.fetchPublicSnapshot(
      { researchChannelId: channelId, credentialRef: { userId: session.user.id } },
      { createdVia: "web_ui" }
    );
    return NextResponse.json({ evidence }, { status: 201 });
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
    }
    return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
