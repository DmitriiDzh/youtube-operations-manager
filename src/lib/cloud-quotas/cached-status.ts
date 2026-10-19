/**
 * BL-203 (docs/roadmap/plans/FAST_NAVIGATION_PLAN.md §2 stage 3): one quota status read shared by everyone who asks within `ttlMs`.
 * `GET /api/settings` carries the Cloud quota status, and the Settings tab alone mounts about a dozen blocks that each fetch it at
 * once -- each fetch used to make its own ~8 Cloud Monitoring calls (~0.4 s). Concurrent callers share one in-flight read; a
 * finished read is reused until it is `ttlMs` old. A failed read is never reused.
 */
export function createCachedReader<T>(load: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  let last: { value: T; at: number } | null = null;
  return () => {
    if (last && now() - last.at < ttlMs) return Promise.resolve(last.value);
    if (inFlight) return inFlight;
    const read = load().then(
      (value) => {
        last = { value, at: now() };
        inFlight = null;
        return value;
      },
      (error: unknown) => {
        inFlight = null;
        throw error;
      }
    );
    inFlight = read;
    return read;
  };
}
