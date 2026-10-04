import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { errorResponse, unauthorized, type SessionLike } from "./shared";

type Deps = {
  getSession: () => Promise<SessionLike>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "listCollectionRequests">;
};

// Agent-created collection requests (docs/decisions/0021-agent-collection-requests.md) -- the Research tab's review queue. Read-only:
// creating a request is agent-facing (MCP/CLI); approving and rejecting are the sibling Web-only routes.
export function createCollectionRequestsListHandlers(
  deps: Deps = { getSession: () => getServerSession(authOptions), core: createMarketIntelligenceCore() }
) {
  return {
    async GET() {
      const session = await deps.getSession();
      if (!session?.user?.id) return unauthorized();
      try {
        return NextResponse.json(await deps.core.listCollectionRequests());
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export const GET = createCollectionRequestsListHandlers().GET;
