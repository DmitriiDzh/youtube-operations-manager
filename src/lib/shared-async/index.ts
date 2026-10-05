// The one promise-returning `sleep` (AGENTS.md §M, Phase 14 review round 11): every poll/confirm loop in
// the codebase used to carry its own `new Promise(r => setTimeout(r, ms))`. `unref` lets a short-lived
// process (the operator CLI) exit while a timer is pending instead of being held open by it.

export function sleep(ms: number, options: { unref?: boolean } = {}): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (options.unref && typeof timer === "object" && timer !== null && "unref" in timer) (timer as { unref(): void }).unref();
  });
}

/** Two decimals, the money rounding every media estimate/cost uses. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
