import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { errorResponse, unauthorized, type SessionLike } from "../collection-requests/shared";

export type WatchlistTableDeps = {
  getSession: () => Promise<SessionLike>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "getWatchlistTable">;
};

// BL-140 R3 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.3): the rows of Research → Channels. Local read only.
// Not under /channels/ so it can never be mistaken for a `[channelId]` route.
export function createWatchlistTableHandler(
  deps: WatchlistTableDeps = { getSession: () => getServerSession(authOptions), core: createMarketIntelligenceCore() }
) {
  return async function GET() {
    const session = await deps.getSession();
    if (!session?.user?.id) return unauthorized();
    try {
      return NextResponse.json(await deps.core.getWatchlistTable());
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const GET = createWatchlistTableHandler();
