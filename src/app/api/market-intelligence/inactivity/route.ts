import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type InactivityRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "getInactivitySetting" | "setInactivitySetting">;
};

const defaultDeps: InactivityRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createMarketIntelligenceCore(),
};

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

// BL-163 (FO-REQ-0014 §A2): "inactive after N months without uploads" (1-60, default 6). Global, like the watchlist.
export function createInactivityHandlers(deps: InactivityRouteDeps = defaultDeps) {
  return {
    async GET() {
      const session = await deps.getSession();
      if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        return NextResponse.json(await deps.core.getInactivitySetting());
      } catch (error) {
        return errorResponse(error);
      }
    },
    async POST(request: Request) {
      const session = await deps.getSession();
      if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
        }
        return NextResponse.json(await deps.core.setInactivitySetting(body));
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = createInactivityHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
