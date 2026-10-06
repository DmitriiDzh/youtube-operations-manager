import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { pageMarketVideos, parseVideosQuery } from "./paging";

type VideosOverviewRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "getMarketVideosOverview" | "listWatchlist">;
};

const defaultDeps: VideosOverviewRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createMarketIntelligenceCore(),
};

// Phase 9 slice 9H, part C (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_C_PLAN.md §5) -- injectable
// factory shape, matching parts A/B's own precedent. No path params -- aggregates per-video across
// the whole watchlist, not one channel.
export function createVideosOverviewGetHandler(deps: VideosOverviewRouteDeps = defaultDeps) {
  // BL-140 R2: with `?page=` the response is one page `{ rows, total, page, limit, channels, topics }` (paging.ts);
  // without it, the old unpaged `{ videos, methodology }` (AC-R2-4).
  return async function GET(request?: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const query = request ? parseVideosQuery(new URL(request.url).searchParams) : null;
      // A channel filter is applied in the service too, so only that channel's series is read (BL-140 review).
      const result = await deps.core.getMarketVideosOverview(query?.channelId ? { channelId: query.channelId } : {});
      if (query) {
        const page = pageMarketVideos(result.videos, query);
        if (!query.channelId) return NextResponse.json(page);
        // Narrowed to one channel, the rows no longer list every channel: offer the whole watchlist in the channel
        // filter instead, so the owner can switch straight to another channel.
        const { channels } = await deps.core.listWatchlist();
        const options = channels
          .map((c) => ({ channelId: c.channelId, label: c.handleOrUrl ?? c.channelId }))
          .sort((a, b) => a.label.localeCompare(b.label));
        return NextResponse.json({ ...page, channels: options });
      }
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json(
          { error: error.code, message: error.message, details: error.details },
          { status: getVideoMetadataErrorStatus(error.code) }
        );
      }
      return NextResponse.json(
        { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 }
      );
    }
  };
}

export const GET = createVideosOverviewGetHandler();
