// The one money-rounding helper (AGENTS.md §M, Phase 14 review round 21: it lived in shared-async, where the next
// money helper would not have been looked for).

/** Two decimals, the rounding every media estimate/cost uses. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * BL-174: four decimals, always UP (sub-cent API prices: a Nano Banana image is $0.0336). The epsilon keeps a value that is
 * exactly on a step in decimal (0.06555 -> 0.0656, 0.96 -> 0.96) from being pushed one step higher by floating-point noise.
 */
export function ceil4(value: number): number {
  return Math.ceil(value * 10_000 - 1e-9) / 10_000;
}
