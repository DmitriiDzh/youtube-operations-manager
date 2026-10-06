import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { errorResponse, unauthorized, type SessionLike } from "../collection-requests/shared";
import { pageCandidates, parseCandidatesQuery } from "./paging";

export type DiscoveryCandidatesDeps = {
  getSession: () => Promise<SessionLike>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "listDiscoveryCandidates">;
};

// Phase 9 slice 9C -- read-only list of discovery candidates, newest lastSeenAt first.
// BL-140 R4: with `?page=` the response is one page `{ candidates, total, page, limit, counts }`, optionally narrowed by
// `status` (paging.ts); without it, the old unpaged `{ candidates }`.
export function createDiscoveryCandidatesGetHandler(
  deps: DiscoveryCandidatesDeps = { getSession: () => getServerSession(authOptions), core: createMarketIntelligenceCore() }
) {
  return async function GET(request?: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) return unauthorized();
    try {
      const result = await deps.core.listDiscoveryCandidates();
      const query = request ? parseCandidatesQuery(new URL(request.url).searchParams) : null;
      return NextResponse.json(query ? pageCandidates(result.candidates, query) : result);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const GET = createDiscoveryCandidatesGetHandler();
