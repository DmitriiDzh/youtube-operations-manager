import { test } from "node:test";
import assert from "node:assert/strict";
import { createResearchSummaryHandler, type ResearchSummaryDeps } from "./route";

// BL-140 R1 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.1/§4.2, AC-R1-2/4): one local read that feeds the
// Research summary line and the sidebar's pending count. Expected values are written by hand from the fixture.

const session = async () => ({ user: { id: "u1" } });

function deps(overrides: Record<string, unknown> = {}): ResearchSummaryDeps {
  return {
    getSession: session,
    core: {
      // BL-140 review: the counts come from getResearchSummaryCounts (getMarketOverview was too heavy to poll).
      getResearchSummaryCounts: async () => ({ watchlistCount: 38, warningCount: 1, newDiscoveryCount: 2 }),
      getSearchUsage: async () => ({ searchesUsedToday: 3, dailyLimit: 100, quotaDayStartedAt: "2026-10-06T07:00:00.000Z" }),
      getCollectionLimits: async () => ({ dailyBudgetUnits: 500, unitsSpentToday: 120, remainingTodayUnits: 380 }),
      listResearchRequests: async () => ({ requests: [{ status: "pending" }, { status: "executed" }, { status: "pending" }] }),
      listCollectionRequests: async () => ({ requests: [{ status: "pending" }, { status: "running" }, { status: "done" }] }),
      ...overrides,
    },
  } as unknown as ResearchSummaryDeps;
}

test("AC-R1-2/4: the summary counts channels, warnings, new discoveries, today's quota and pending agent requests", async () => {
  const res = await createResearchSummaryHandler(deps())();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    watchlistCount: 38,
    warningCount: 1,
    newDiscoveryCount: 2,
    searches: { usedToday: 3, dailyLimit: 100 },
    collectionBudget: { dailyBudgetUnits: 500, unitsSpentToday: 120, remainingTodayUnits: 380 },
    pending: { researchRequests: 2, collectionRequests: 1, total: 3 },
  });
});

test("the summary needs a signed-in session", async () => {
  const res = await createResearchSummaryHandler({ ...deps(), getSession: async () => null })();
  assert.equal(res.status, 401);
});

test("one failing source does not hide the others (each part is optional, AGENTS.md §M)", async () => {
  const res = await createResearchSummaryHandler(
    deps({
      getResearchSummaryCounts: async () => {
        throw new Error("boom");
      },
    })
  )();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.watchlistCount, null);
  assert.equal(body.warningCount, null);
  assert.deepEqual(body.pending, { researchRequests: 2, collectionRequests: 1, total: 3 });
});
