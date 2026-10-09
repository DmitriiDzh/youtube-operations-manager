import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type ChannelPauseRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "setWatchlistPause">;
};

const defaultDeps: ChannelPauseRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createMarketIntelligenceCore(),
};

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

// BL-163 (FO-REQ-0014 §A, WATCHLIST_HYGIENE_PROPOSALS_PLAN.md): the owner pauses (`{ paused: true }`) or resumes (`false`) one
// watchlist entry; a paused entry is never collected. The watchlist is global, so a session is the gate, like its sibling routes;
// the service refuses a channel that is not on the watchlist.
export function createChannelPauseHandler(deps: ChannelPauseRouteDeps = defaultDeps) {
  return async function POST(request: Request, { params }: { params: Promise<{ channelId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
      }
      const { channelId } = await params;
      const paused = body && typeof body === "object" ? (body as { paused?: unknown }).paused : undefined;
      return NextResponse.json({ channel: await deps.core.setWatchlistPause({ channelId, paused }) });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const POST = createChannelPauseHandler();
