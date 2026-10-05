import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type IntelligenceSummaryRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "getChannelIntelligenceSummary">;
};

const defaultDeps: IntelligenceSummaryRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createMarketIntelligenceCore(),
};

// Phase 9 slice 9H, part A (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md §4b) -- injectable
// factory shape from the start, so a test can inject a fake `core` (this module has already
// shipped one real regression from a route with no test of its own this session).
export function createIntelligenceSummaryGetHandler(deps: IntelligenceSummaryRouteDeps = defaultDeps) {
  return async function GET(_request: Request, { params }: { params: Promise<{ channelId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const { channelId } = await params;
      const result = await deps.core.getChannelIntelligenceSummary({ channelId });
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

export const GET = createIntelligenceSummaryGetHandler();
