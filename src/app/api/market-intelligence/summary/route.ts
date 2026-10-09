import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAgentProposalReviewCore } from "@/lib/agent-proposals";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { unauthorized, type SessionLike } from "../collection-requests/shared";

type Core = Pick<
  ReturnType<typeof createMarketIntelligenceCore>,
  "getResearchSummaryCounts" | "getSearchUsage" | "getCollectionLimits" | "listResearchRequests" | "listCollectionRequests"
>;

export type ResearchSummaryDeps = {
  getSession: () => Promise<SessionLike>;
  core: Core;
  /** BL-163: the agent proposals waiting for the owner, counted into the inbox badge. */
  proposals: Pick<ReturnType<typeof createAgentProposalReviewCore>, "countPendingProposals">;
};

// BL-140 R1 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.1/§4.2): the Research summary line and the sidebar's
// pending count, in one local read (no YouTube call). Each part is read on its own: one failing source leaves only its
// own fields null and never hides the pending agent requests (AGENTS.md §M).
export function createResearchSummaryHandler(
  deps: ResearchSummaryDeps = { getSession: () => getServerSession(authOptions), core: createMarketIntelligenceCore(), proposals: createAgentProposalReviewCore() }
) {
  return async function GET() {
    const session = await deps.getSession();
    if (!session?.user?.id) return unauthorized();
    const settle = <T,>(p: Promise<T>) => p.then((value) => value, () => null);
    const [counts, searches, budget, research, collection, proposals] = await Promise.all([
      settle(deps.core.getResearchSummaryCounts()),
      settle(deps.core.getSearchUsage()),
      settle(deps.core.getCollectionLimits()),
      settle(deps.core.listResearchRequests()),
      settle(deps.core.listCollectionRequests()),
      settle(deps.proposals.countPendingProposals()),
    ]);
    const pendingResearch = research ? research.requests.filter((r) => r.status === "pending").length : null;
    const pendingCollection = collection ? collection.requests.filter((r) => r.status === "pending").length : null;
    return NextResponse.json({
      watchlistCount: counts ? counts.watchlistCount : null,
      warningCount: counts ? counts.warningCount : null,
      newDiscoveryCount: counts ? counts.newDiscoveryCount : null,
      searches: searches ? { usedToday: searches.searchesUsedToday, dailyLimit: searches.dailyLimit } : null,
      collectionBudget: budget
        ? { dailyBudgetUnits: budget.dailyBudgetUnits, unitsSpentToday: budget.unitsSpentToday, remainingTodayUnits: budget.remainingTodayUnits }
        : null,
      pending: {
        researchRequests: pendingResearch,
        collectionRequests: pendingCollection,
        agentProposals: proposals,
        total: (pendingResearch ?? 0) + (pendingCollection ?? 0) + (proposals ?? 0),
      },
    });
  };
}

export const GET = createResearchSummaryHandler();
