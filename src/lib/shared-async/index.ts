// The one promise-returning `sleep` (AGENTS.md §M, Phase 14 review round 11): every poll/confirm loop in
// the codebase used to carry its own `new Promise(r => setTimeout(r, ms))`. `unref` lets a short-lived
// process (the operator CLI) exit while a timer is pending instead of being held open by it. `signal` (BL-271): the sleep ends
// early -- resolving, never rejecting -- once the signal is aborted (a wait that must stop at once when the server stops).

export function sleep(ms: number, options: { unref?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  return new Promise<void>((resolve) => {
    const { signal } = options;
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (options.unref && typeof timer === "object" && timer !== null && "unref" in timer) (timer as { unref(): void }).unref();
    signal?.addEventListener("abort", done, { once: true });
  });
}
