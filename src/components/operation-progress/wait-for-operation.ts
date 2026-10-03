/**
 * Waits for a server-run operation (operation registry, ADR 0015) to end, without showing anything.
 * Used when a start request was refused with 409 `operation_already_running`: the same work is already
 * in progress, so the caller waits for it and carries on instead of reporting an error.
 *
 * Resolves `"finished"` on any final status, `"gone"` when the registry no longer knows the id (404:
 * expired, or the server restarted), `"timeout"` when the limit is hit. A failed poll is not an answer:
 * it is retried until the limit.
 */
export async function waitForOperation(
  operationId: string,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {}
): Promise<"finished" | "gone" | "timeout"> {
  const intervalMs = options.intervalMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const startedAt = now();

  for (;;) {
    try {
      const res = await doFetch(`/api/operations/${encodeURIComponent(operationId)}`);
      if (res.status === 404) return "gone";
      if (res.ok) {
        const snapshot = (await res.json()) as { status?: string };
        if (snapshot.status !== "running" && snapshot.status !== "cancelling") return "finished";
      }
    } catch {
      // Transient: keep waiting.
    }
    if (now() - startedAt >= timeoutMs) return "timeout";
    await sleep(intervalMs);
  }
}
