/**
 * A one-shot initialization promise that can recover. A plain `const init = start()` that rejects
 * keeps every later caller failing for the life of the process, even after the operator fixes the
 * cause (e.g. clears a stale operation lock from the /recovery page) -- forcing a restart. After a
 * failed attempt the NEXT `get()` starts a fresh attempt, at most once per `minRetryIntervalMs`
 * (callers in between receive the cached failure, so a broken start is not hammered). A pending or
 * successful attempt is never restarted. Every attempt's rejection is marked handled here, so a
 * failed boot cannot surface as an unhandled rejection that terminates the process.
 */
export function createRecoverableInitializer(
  start: () => Promise<void>,
  options: { minRetryIntervalMs: number; now?: () => number }
) {
  const now = options.now ?? Date.now;
  let current: Promise<void> = start();
  let failedAt: number | null = null;

  const track = (attempt: Promise<void>) => {
    attempt.then(
      () => {
        if (current === attempt) failedAt = null;
      },
      () => {
        if (current === attempt) failedAt = now();
      }
    );
  };
  track(current);

  return {
    /** The first attempt, for callers that await boot itself. */
    first: current,
    get(): Promise<void> {
      if (failedAt !== null && now() - failedAt >= options.minRetryIntervalMs) {
        failedAt = null;
        current = start();
        track(current);
      }
      return current;
    },
  };
}
