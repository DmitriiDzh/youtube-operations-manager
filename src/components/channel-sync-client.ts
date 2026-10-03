import { waitForOperation } from "./operation-progress/wait-for-operation";

type SyncResponseLike = { ok: boolean; status: number };

export type ChannelSyncOutcome = {
  res: SyncResponseLike;
  /** The parsed JSON body; `null` when this call did not itself sync (see `waitedForOther`). */
  data: Record<string, unknown> | null;
  /** True when another sync was already running and this call waited for it. */
  waitedForOther: boolean;
};

/**
 * `POST /api/channels/sync` that treats "a sync is already running" (409 `operation_already_running`,
 * ADR 0015) as something to wait out, not as an error -- concurrent syncs used to simply both succeed,
 * so every caller would otherwise have to handle a new failure.
 *  - `retry` (a sync the operator asked for): wait for the running one, then sync once more, so the
 *    data is fresh and the result carries the channel. A second 409 is reported as the failure it is.
 *  - `skip` (an automatic background resync): wait, do not sync again; the other sync did the work.
 * Every other failure is returned unchanged so each caller's own error handling keeps working.
 */
export async function postChannelSync(
  channelId: string | undefined,
  options: {
    onConflict: "retry" | "skip";
    fetchImpl?: typeof fetch;
    wait?: (operationId: string) => Promise<"finished" | "gone" | "timeout">;
  }
): Promise<ChannelSyncOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  const wait = options.wait ?? ((operationId: string) => waitForOperation(operationId));

  const post = async () => {
    const res = await doFetch("/api/channels/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(channelId ? { channelId } : {}),
    });
    return { res, data: (await res.json()) as Record<string, unknown> };
  };

  const first = await post();
  const runningId = (first.data.details as { operationId?: unknown } | undefined)?.operationId;
  const alreadyRunning = first.res.status === 409 && first.data.error === "operation_already_running" && typeof runningId === "string";
  if (!alreadyRunning) return { res: first.res, data: first.data, waitedForOther: false };

  const waited = await wait(runningId);
  if (waited === "timeout") {
    return {
      res: { ok: false, status: 409 },
      data: { error: "operation_already_running", message: "Another sync is still running and did not finish in time. Try again in a moment." },
      waitedForOther: true,
    };
  }
  if (options.onConflict === "skip") return { res: { ok: true, status: 200 }, data: null, waitedForOther: true };

  const second = await post();
  return { res: second.res, data: second.data, waitedForOther: true };
}
