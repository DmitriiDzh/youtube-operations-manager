import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type SnapshotHistoryRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "getChannelVideoSnapshotHistory">;
};

const defaultDeps: SnapshotHistoryRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createMarketIntelligenceCore(),
};

// Phase 9 slice 9H, part A (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md §4a/§4b) -- the
// bounded per-video drill-down: one video's own snapshot series, filtered server-side, never the
// full unbounded per-channel array (see the Channels intelligence-summary route, which excludes
// `videoSnapshots` from its own response for exactly this reason).
export function createSnapshotHistoryGetHandler(deps: SnapshotHistoryRouteDeps = defaultDeps) {
  return async function GET(_request: Request, { params }: { params: Promise<{ channelId: string; videoId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const { channelId, videoId } = await params;
      const result = await deps.core.getChannelVideoSnapshotHistory({ channelId, videoId });
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

export const GET = createSnapshotHistoryGetHandler();
