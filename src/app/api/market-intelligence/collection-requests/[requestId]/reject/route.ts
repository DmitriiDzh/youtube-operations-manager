import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { errorResponse, unauthorized, type SessionLike } from "../../shared";

type Deps = {
  getSession: () => Promise<SessionLike>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "rejectCollectionRequest">;
};

// Web-UI ONLY counterpart to .../approve: records the human's reason, collects nothing, makes no YouTube call.
export function createCollectionRejectHandlers(
  deps: Deps = { getSession: () => getServerSession(authOptions), core: createMarketIntelligenceCore() }
) {
  return {
    async POST(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
      const session = await deps.getSession();
      if (!session?.user?.id) return unauthorized();
      try {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
        }
        const bodyRecord = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
        const { requestId } = await params;
        return NextResponse.json(await deps.core.rejectCollectionRequest({ requestId, reason: bodyRecord.reason }));
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export const POST = createCollectionRejectHandlers().POST;
