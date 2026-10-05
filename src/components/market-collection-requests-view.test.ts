import assert from "node:assert/strict";
import test from "node:test";
import { budgetSentence, estimateSentence, OUTCOME_LABELS, runSummary, unitsText } from "./market-collection-requests-view";

test("unitsText pluralizes: 1 unit, 0 units, 8 units", () => {
  assert.equal(unitsText(1), "1 unit");
  assert.equal(unitsText(0), "0 units");
  assert.equal(unitsText(8), "8 units");
});

test("estimateSentence states both numbers as upper bounds in YouTube quota units", () => {
  assert.equal(
    estimateSentence({ totalExpectedUnits: 23, totalWorstCaseUnits: 42 }),
    "Estimated cost: about 23 units, at most 42 units of the YouTube Data API daily quota (upper bounds)."
  );
});

test("budgetSentence: fits vs does not fit", () => {
  const base = { dailyBudgetUnits: 1000, unitsSpentToday: 120, remainingTodayUnits: 880 };
  assert.equal(budgetSentence({ ...base, fitsToday: true }), "Daily budget 1000, spent today 120, left 880. The worst case fits today.");
  assert.match(budgetSentence({ ...base, fitsToday: false }), /may not fit today: collection stops at the budget and continues/);
});

test("runSummary: counts collected and partial channels, not skipped or failed ones; failed requests show the error", () => {
  const result = [
    { channelId: "a", outcome: "completed" as const, videosStored: 5, newSnapshotsObservedAt: "x", unitsSpent: 3 },
    { channelId: "b", outcome: "partial_budget" as const, videosStored: 50, newSnapshotsObservedAt: "x", unitsSpent: 2 },
    { channelId: "c", outcome: "skipped_not_stale" as const, videosStored: 0, newSnapshotsObservedAt: null, unitsSpent: 0 },
    { channelId: "d", outcome: "failed" as const, videosStored: 0, newSnapshotsObservedAt: null, unitsSpent: 1 },
  ];
  assert.equal(runSummary({ status: "done", result, unitsSpentTotal: 6, error: null }), "2 of 4 channels collected, 6 units spent.");
  assert.equal(runSummary({ status: "done", result: [result[0]], unitsSpentTotal: 1, error: null }), "1 of 1 channel collected, 1 unit spent.");
  assert.equal(runSummary({ status: "failed", result: null, unitsSpentTotal: 0, error: "boom" }), "boom");
});

test("every outcome has a label", () => {
  assert.deepEqual(Object.keys(OUTCOME_LABELS).sort(), ["completed", "failed", "partial_budget", "skipped_not_stale", "skipped_quota_limited", "skipped_recent_failure"]);
});
