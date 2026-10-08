// Pure display helpers for the "Collection requests" panel (docs/decisions/0021-agent-collection-requests.md): no React, no fetching,
// so the wording of the cost and of each outcome is unit-testable. Units are YouTube Data API quota units, never model tokens.
// BL-152: the wording lives in the interface-text keys (`requests.collection.*`); each helper takes the panel's `t`.

import type { Translate, UiTextKey } from "@/lib/ui-text";

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

export const OUTCOME_LABELS: Record<CollectionOutcome, UiTextKey> = {
  completed: "requests.collection.outcome.completed",
  partial_budget: "requests.collection.outcome.partial_budget",
  failed: "requests.collection.outcome.failed",
  skipped_not_stale: "requests.collection.outcome.skipped_not_stale",
  skipped_recent_failure: "requests.collection.outcome.skipped_recent_failure",
  skipped_quota_limited: "requests.collection.outcome.skipped_quota_limited",
};

export function unitsText(t: Translate, units: number): string {
  return t("requests.collection.units", { count: units });
}

/** The cost sentence shown on a pending request and in the approve dialog. Upper bounds, stated as such. */
export function estimateSentence(t: Translate, estimate: { totalExpectedUnits: number; totalWorstCaseUnits: number }): string {
  return t("requests.collection.estimate", { expected: estimate.totalExpectedUnits, worst: estimate.totalWorstCaseUnits });
}

export function budgetSentence(
  t: Translate,
  estimate: { dailyBudgetUnits: number; unitsSpentToday: number; remainingTodayUnits: number; fitsToday: boolean },
): string {
  // Plain digits, as before (no grouping) -- the same figures the limits line above shows.
  const params = { budget: String(estimate.dailyBudgetUnits), spent: String(estimate.unitsSpentToday), left: String(estimate.remainingTodayUnits) };
  return t(estimate.fitsToday ? "requests.collection.budgetFits" : "requests.collection.budgetMayNotFit", params);
}

/** One line for the progress pop-up when the run returns. */
export function runSummary(
  t: Translate,
  request: { status: string; result: CollectionChannelResultView[] | null; unitsSpentTotal: number | null; error: string | null },
): string {
  if (request.status === "failed") return request.error ?? t("requests.collection.failedSummary");
  const results = request.result ?? [];
  const collected = results.filter((r) => r.outcome === "completed" || r.outcome === "partial_budget").length;
  return t("requests.collection.runSummary", { collected, total: results.length, units: request.unitsSpentTotal ?? 0 });
}
