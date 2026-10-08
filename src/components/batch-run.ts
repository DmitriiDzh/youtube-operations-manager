import { deriveBatchStage, ledgerRowToItem, summarizeBatchRows, type ProgressLedgerRow } from "./batch-progress";
import type { Translate } from "@/lib/ui-text";
import type { OperationController } from "./operation-progress";
import { parseQuotaBlock, type QuotaBlock } from "./quota-block-dialog";

export type BatchRunResult =
  | { kind: "finished"; rows: ProgressLedgerRow[] }
  | { kind: "quota_block"; block: QuotaBlock }
  | { kind: "error"; message: string };

const NOT_WRITTEN_STATUSES = ["FAILED", "CONFLICT", "ABORTED_SYSTEMIC", "UNKNOWN"];

/**
 * Runs one blocking batch request (`execute` / `prepare`) while polling the batch GET route, which
 * reports each ledger row's status as the server commits it -- so the overlay shows real per-video
 * progress without any server-side change. Polling lives only as long as THIS request, so a stale batch
 * left PENDING in the database can never produce an unclosable overlay. Cancel (live execution only)
 * asks the SERVER to stop before the next video (ADR 0016); the overlay keeps polling until the execute
 * request itself returns, so it never claims a stop that did not happen.
 *
 * Shared by the Batches tab and the Languages tab's one-click send (ADR 0020) so there is one
 * implementation of the progress/quota/cancel handling, not two. It never decides what is written: it
 * only calls the existing `prepare` / `execute` routes.
 *
 * `failOnUnwrittenRows`: end the overlay as an error (not "success") when any row did not get written.
 */
export async function runBatchWithProgress(args: {
  channelId: string;
  batchId: string;
  kind: "execute" | "prepare";
  op: OperationController;
  title: string;
  failureMessage: string;
  acknowledgeUnknownQuota?: boolean;
  failOnUnwrittenRows?: boolean;
  /** BL-152: the interface language's translator, for the stage/row/summary texts. */
  t: Translate;
}): Promise<BatchRunResult> {
  const { channelId, batchId, kind, op, title, failureMessage, t } = args;
  const base = `/api/channels/${encodeURIComponent(channelId)}/batches/${encodeURIComponent(batchId)}`;
  const dryRun = kind === "prepare";
  // Only a live execution can be cancelled (ADR 0016); a dry run writes nothing and is short.
  op.start({ title, cancellable: kind === "execute", quotaServices: ["dataApi"] });
  op.setStage(dryRun ? deriveBatchStage([], true, t) : t("batches.progress.stagePreparing"));

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const res = await fetch(base);
      if (!res.ok) return;
      const data = await res.json();
      const rows = (data.ledgerRows ?? []) as ProgressLedgerRow[];
      op.setItems(rows.map((row) => ledgerRowToItem(row, t)));
      op.setStage(deriveBatchStage(rows, dryRun, t));
    } catch {
      // A missed poll only delays the display; the request below is the source of truth.
    } finally {
      polling = false;
    }
  }
  void poll();
  const timer = setInterval(() => void poll(), 1500);

  try {
    const res = await fetch(`${base}/${kind}`, {
      method: "POST",
      ...(args.acknowledgeUnknownQuota
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ acknowledgeUnknownQuota: true }) }
        : {}),
    });
    const data = await res.json();
    clearInterval(timer);
    if (!res.ok) {
      // BL-117: a quota refusal is not an error to dump in the red line: it is a decision for the user (nothing was started).
      const quota = kind === "execute" ? parseQuotaBlock(data) : null;
      if (quota) {
        op.reset();
        return { kind: "quota_block", block: quota };
      }
      throw new Error((data as { message?: string }).message ?? failureMessage);
    }
    const finalRes = await fetch(base);
    const finalRows = finalRes.ok ? (((await finalRes.json()).ledgerRows ?? []) as ProgressLedgerRow[]) : [];
    // Synchronous with finish below, so a poll still in flight can never overwrite the final state.
    op.setItems(finalRows.map((row) => ledgerRowToItem(row, t)));
    const summary = summarizeBatchRows(finalRows, dryRun, t);
    if (args.failOnUnwrittenRows && finalRows.some((row) => NOT_WRITTEN_STATUSES.includes(row.status))) {
      op.finish({ error: true, message: summary });
    } else {
      op.finish({
        // Cancel may arrive too late (everything already written): trust the server's own answer.
        outcome: data.cancelled === true ? "cancelled" : "success",
        message: summary,
      });
    }
    return { kind: "finished", rows: finalRows };
  } catch (e) {
    clearInterval(timer);
    const message = e instanceof Error ? e.message : failureMessage;
    op.finish({ error: true, message });
    return { kind: "error", message };
  }
}
