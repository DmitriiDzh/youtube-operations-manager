import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { errorResponse, unauthorized, type SessionLike } from "../../shared";

type Deps = {
  getSession: () => Promise<SessionLike>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "runApprovedCollectionRequest">;
};

// Web-UI ONLY -- the one way a collection request is approved and run (no MCP tool or CLI command reaches the underlying action; fenced by
// the approval inventory test). The caller's own session user is the credential for the run, and the request BLOCKS until the collection
// has finished (owner decision 2026-10-04: a blocking pop-up like "Send to YouTube", not a background job). The run is the REGULAR
// collection for the request's channels -- same 24 h stale window, failure pause and daily budget.
export function createCollectionApproveHandlers(
  deps: Deps = { getSession: () => getServerSession(authOptions), core: createMarketIntelligenceCore() }
) {
  return {
    async POST(_request: Request, { params }: { params: Promise<{ requestId: string }> }) {
      const session = await deps.getSession();
      if (!session?.user?.id) return unauthorized();
      try {
        const { requestId } = await params;
        const result = await deps.core.runApprovedCollectionRequest({ requestId, credentialRef: { userId: session.user.id } });
        return NextResponse.json(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export const POST = createCollectionApproveHandlers().POST;
