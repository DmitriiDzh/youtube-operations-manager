import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type CollectionDepthRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "getCollectionDepthDefaults" | "setCollectionDepthDefaults">;
};

const defaultDeps: CollectionDepthRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createMarketIntelligenceCore(),
};

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

// Operator request 2026-10-04 -- the global default collection depth (how many of a watchlisted competitor's newest uploads are
// collected, and an optional earliest publish date). Global, like the watchlist itself; a channel's own override wins.
export function createCollectionDepthHandlers(deps: CollectionDepthRouteDeps = defaultDeps) {
  return {
    async GET() {
      const session = await deps.getSession();
      if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        return NextResponse.json(await deps.core.getCollectionDepthDefaults());
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
        await deps.core.setCollectionDepthDefaults(body);
        return NextResponse.json(await deps.core.getCollectionDepthDefaults());
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = createCollectionDepthHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
