import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { errorResponse, unauthorized, type SessionLike } from "../shared";

type Deps = {
  getSession: () => Promise<SessionLike>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "getCollectionLimits">;
};

// The owner's daily collection budget and what is left today (local read, no YouTube call) -- shown next to the pending requests.
export function createCollectionLimitsHandlers(
  deps: Deps = { getSession: () => getServerSession(authOptions), core: createMarketIntelligenceCore() }
) {
  return {
    async GET() {
      const session = await deps.getSession();
      if (!session?.user?.id) return unauthorized();
      try {
        return NextResponse.json(await deps.core.getCollectionLimits());
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export const GET = createCollectionLimitsHandlers().GET;
