// Matches services.ts's own FieldVelocity shape structurally -- defined locally, not imported,
// matching the convention the two panels below already used before this extraction (client
// components in this codebase read API response shapes structurally rather than importing
// server-side types across the boundary).
type FieldVelocity = {
  value: number | null;
  basis: "insufficient_history" | "stale_latest" | "partial_window" | "full_window" | "withheld_by_policy";
};

// Extracted from market-research-panel.tsx (found by independent review, 2026-09-29): market-
// videos-panel.tsx (9H part C) had its own inline copy of this, citing RISK-77 as already tracking
// the duplication -- RISK-77 actually covers a different, unrelated duplication (a stale-fetch-
// response request-id race guard), so this one was real and uncovered. The videos-panel copy was
// also not byte-identical -- it was missing two precision fixes independent review had already
// made here (the `full_window`/`stale_latest` clauses below), so extracting this one shared
// implementation also silently fixes that drift, not just the duplication.
//
// A `stale_latest`/`partial_window` rate must never be presented as a genuine N-day window figure
// (derived-metrics.ts's own contract: `stale_latest` is a best-effort rate over a MUCH longer,
// unstated span, and `partial_window` only covers whatever span was actually observed) -- found by
// independent code review: an earlier version of this label always printed "(N-day window)"
// regardless of basis, contradicting the function it was displaying.
export function formatFieldVelocity(field: FieldVelocity, unit: string, windowDays: number): string {
  if (field.basis === "withheld_by_policy") return "not shown (YouTube API policy: no metrics derived from other channels' data)";
  if (field.value === null) return `no data (${field.basis})`;
  const perDay = field.value >= 0 ? `+${field.value.toFixed(2)}` : field.value.toFixed(2);
  const rate = `${perDay} ${unit}/day`;
  switch (field.basis) {
    case "full_window":
      // NOT "over the last N days" -- computeSnapshotVelocity's own full_window basis only
      // guarantees a snapshot exists AT OR BEFORE the window's start, not AT it; the real span used
      // can be arbitrarily longer than windowDays (found by independent code review).
      return `${rate} (at least the last ${windowDays} days, possibly longer -- an earlier snapshot exists)`;
    case "partial_window":
      return `${rate} (partial -- covers only the span actually observed, less than ${windowDays} days)`;
    case "stale_latest":
      return `${rate} (NOT a real last-${windowDays}-day rate -- the latest observation is itself older than ${windowDays} days; best-effort over a longer span)`;
    default:
      return `${rate} (${field.basis})`;
  }
}
