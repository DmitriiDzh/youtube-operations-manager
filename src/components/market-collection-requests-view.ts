// Pure display helpers for the "Collection requests" panel (docs/decisions/0021-agent-collection-requests.md): no React, no fetching,
// so the wording of the cost and of each outcome is unit-testable. Units are YouTube Data API quota units, never model tokens.

export type CollectionOutcome =
  | "completed"
  | "partial_budget"
  | "failed"
  | "skipped_not_stale"
  | "skipped_recent_failure"
  | "skipped_quota_limited";

export type CollectionChannelResultView = {
  channelId: string;
  outcome: CollectionOutcome;
  videosStored: number;
  newSnapshotsObservedAt: string | null;
  unitsSpent: number;
};

export const OUTCOME_LABELS: Record<CollectionOutcome, string> = {
  completed: "Collected",
  partial_budget: "Partly collected (daily budget reached; continues next time)",
  failed: "Failed",
  skipped_not_stale: "Skipped (already collected within 24 h)",
  skipped_recent_failure: "Skipped (failed within the last 24 h)",
  skipped_quota_limited: "Skipped (not enough daily budget)",
};

export function unitsText(units: number): string {
  return `${units} unit${units === 1 ? "" : "s"}`;
}

/** The cost sentence shown on a pending request and in the approve dialog. Upper bounds, stated as such. */
export function estimateSentence(estimate: { totalExpectedUnits: number; totalWorstCaseUnits: number }): string {
  return `Estimated cost: about ${unitsText(estimate.totalExpectedUnits)}, at most ${unitsText(estimate.totalWorstCaseUnits)} of the YouTube Data API daily quota (upper bounds).`;
}

export function budgetSentence(estimate: { dailyBudgetUnits: number; unitsSpentToday: number; remainingTodayUnits: number; fitsToday: boolean }): string {
  const base = `Daily budget ${estimate.dailyBudgetUnits}, spent today ${estimate.unitsSpentToday}, left ${estimate.remainingTodayUnits}.`;
  return estimate.fitsToday
    ? `${base} The worst case fits today.`
    : `${base} The worst case may not fit today: collection stops at the budget and continues from where it stopped later.`;
}

/** One line for the progress pop-up when the run returns. */
export function runSummary(request: { status: string; result: CollectionChannelResultView[] | null; unitsSpentTotal: number | null; error: string | null }): string {
  if (request.status === "failed") return request.error ?? "The collection failed.";
  const results = request.result ?? [];
  const collected = results.filter((r) => r.outcome === "completed" || r.outcome === "partial_budget").length;
  return `${collected} of ${results.length} channel${results.length === 1 ? "" : "s"} collected, ${unitsText(request.unitsSpentTotal ?? 0)} spent.`;
}
