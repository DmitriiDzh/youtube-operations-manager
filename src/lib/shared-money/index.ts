// The one money-rounding helper (AGENTS.md §M, Phase 14 review round 21: it lived in shared-async, where the next
// money helper would not have been looked for).

/** Two decimals, the rounding every media estimate/cost uses. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
