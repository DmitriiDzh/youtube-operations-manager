import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { describeResearchSummary, RESEARCH_TABS, type ResearchSummary } from "./research-tab";

// BL-140 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4, §7 R1; owner decisions msg 1827).

test("AC-R1-1: Research has five sub-tabs in this order: Inbox, Channels, Videos, Discover, Topics & trends", () => {
  assert.deepEqual(RESEARCH_TABS.map((t) => t.label), ["Inbox", "Channels", "Videos", "Discover", "Topics & trends"]);
});

test("AC-R1-1/R1-4: the dashboard renders the ResearchTab shell; the stacked Overview panel is gone", async () => {
  const page = await readFile(path.join(process.cwd(), "src", "app", "dashboard", "page.tsx"), "utf8");
  const research = page.slice(page.indexOf('tab === "research"'), page.indexOf('tab === "decisions"'));
  assert.match(research, /<ResearchTab /);
  assert.doesNotMatch(page, /MarketOverviewPanel/);
  // AC-R1-2: the sidebar's Research item carries the pending count.
  assert.match(page, /item\.value === "research" \? \{ \.\.\.item, badge: researchPending \}/);
});

test("AC-R1-1: every sub-tab stays mounted and is only hidden (switching never refetches)", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "components", "research-tab.tsx"), "utf8");
  for (const t of RESEARCH_TABS) assert.match(source, new RegExp(`tab === "${t.value}" \\? "space-y-6" : "hidden"`), t.value);
});

test("AC-R1-2: the first summary opens Inbox only when something is pending; later polls never switch the tab", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "components", "research-tab.tsx"), "utf8");
  assert.match(source, /useState<ResearchSubTab>\("channels"\)/);
  assert.match(source, /if \(!openedOnce\.current\) \{\s*openedOnce\.current = true;\s*if \(data\.pending\.total > 0\) setTab\("inbox"\);/);
});

const full: ResearchSummary = {
  watchlistCount: 38,
  warningCount: 2,
  newDiscoveryCount: 1,
  searches: { usedToday: 3, dailyLimit: 100 },
  collectionBudget: { dailyBudgetUnits: 500, unitsSpentToday: 120, remainingTodayUnits: 380 },
  pending: { researchRequests: 1, collectionRequests: 1, total: 2 },
};

test("AC-R1-4: the summary line names counts, warnings, budget, searches and pending requests, each linking where it belongs", () => {
  assert.deepEqual(describeResearchSummary(full), [
    { text: "38 channels tracked", tone: "plain", goTo: "channels" },
    { text: "2 channels need attention", tone: "warn", goTo: "channels" },
    { text: "1 new discovery", tone: "plain", goTo: "discover" },
    { text: "Collection budget today: 120 of 500 units", tone: "plain" },
    { text: "Searches left today: 97 of 100", tone: "plain" },
    { text: "2 requests waiting for you", tone: "warn", goTo: "inbox" },
  ]);
});

test("the summary line leaves out what is zero or unavailable, and says when automatic collection is off", () => {
  assert.deepEqual(
    describeResearchSummary({
      watchlistCount: null,
      warningCount: 0,
      newDiscoveryCount: 0,
      searches: null,
      collectionBudget: { dailyBudgetUnits: null, unitsSpentToday: 0, remainingTodayUnits: null },
      pending: { researchRequests: 0, collectionRequests: null, total: 0 },
    }),
    [{ text: "Automatic collection is off (no daily budget in Settings → API)", tone: "warn" }]
  );
});
