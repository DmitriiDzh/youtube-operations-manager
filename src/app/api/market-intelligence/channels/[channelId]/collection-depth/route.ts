import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type ChannelCollectionDepthRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "getChannelCollectionProgress" | "setChannelCollectionDepth">;
};

const defaultDeps: ChannelCollectionDepthRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createMarketIntelligenceCore(),
};

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

// Operator request 2026-10-04 -- one watchlisted channel's collection depth (override of the global default), its progress and the
// estimated unit cost. The watchlist is global (not scoped to an owned channel), so a session is the only gate, like its sibling routes;
// the service itself refuses a channel that is not on the watchlist.
export function createChannelCollectionDepthHandlers(deps: ChannelCollectionDepthRouteDeps = defaultDeps) {
  return {
    async GET(_request: Request, { params }: { params: Promise<{ channelId: string }> }) {
      const session = await deps.getSession();
      if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        const { channelId } = await params;
        return NextResponse.json(await deps.core.getChannelCollectionProgress({ channelId }));
      } catch (error) {
        return errorResponse(error);
      }
    },
    async POST(request: Request, { params }: { params: Promise<{ channelId: string }> }) {
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
        // The channel id comes from the URL; it replaces any `channelId` a body might carry.
        const input = typeof body === "object" && body !== null ? { ...(body as Record<string, unknown>), channelId } : body;
        await deps.core.setChannelCollectionDepth(input);
        return NextResponse.json(await deps.core.getChannelCollectionProgress({ channelId }));
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = createChannelCollectionDepthHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
