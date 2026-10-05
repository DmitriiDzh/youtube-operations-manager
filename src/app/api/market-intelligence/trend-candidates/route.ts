import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type TrendCandidatesRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createMarketIntelligenceCore>, "listTrendCandidatesWithFreshness" | "createTrendCandidate">;
};

const defaultDeps: TrendCandidatesRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createMarketIntelligenceCore(),
};

// Phase 9 slice 9E, part B (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md) -- manual/structural
// trend candidates. Creation always requires at least one evidence item (spec §14); the schema
// layer enforces this, not this route.
//
// GET switched to `listTrendCandidatesWithFreshness` in Phase 9 slice 9H, part A
// (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md §6) -- a UI-only wrapper pairing each
// candidate with a freshness label; `listTrendCandidates`/`marketTrendCandidateSchema` themselves
// (the `agent_list_market_records` MCP/CLI contract) are unchanged. Converted to the injectable
// factory shape at the same time (this module has already shipped one real regression from a route
// with no test of its own this session).
export function createTrendCandidatesGetHandler(deps: TrendCandidatesRouteDeps = defaultDeps) {
  return async function GET() {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const result = await deps.core.listTrendCandidatesWithFreshness();
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

export function createTrendCandidatesPostHandler(deps: TrendCandidatesRouteDeps = defaultDeps) {
  return async function POST(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
      }

      const trendCandidate = await deps.core.createTrendCandidate(body, { createdVia: "web_ui" });
      return NextResponse.json({ trendCandidate }, { status: 201 });
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

export const GET = createTrendCandidatesGetHandler();
export const POST = createTrendCandidatesPostHandler();
