import type { Translate } from "@/lib/ui-text";
import type { OperationItem } from "./operation-progress";

// BL-152: display texts are interface-text keys (`batches.progress.*`); `t` is passed in so this module stays pure.
// A ledger status (`CONFLICT`...) and a server error text are shown as they are.

/** The slice of a ledger row the progress view needs (same JSON the batch GET route returns). */
export type ProgressLedgerRow = { id: string; videoId: string; status: string; error: string | null };

/**
 * Maps a ledger row onto an overlay item, following the ledger state machine documented in
 * `src/lib/batches/contracts.ts`:
 *  - PENDING / AWAITING_EXECUTION  -> not started (prepared rows are still waiting for their write);
 *  - APPLYING                      -> a write attempt is in flight;
 *  - SUCCESS / DRY_RUN_COMPLETE    -> finished OK;
 *  - FAILED / CONFLICT / ABORTED_SYSTEMIC -> finished, not written (detail = error or status);
 *  - CANCELLED                     -> skipped: the operator stopped the batch before this video started;
 *  - UNKNOWN                       -> outcome of a sent write could not be confirmed: shown as failed
 *    (needs reconciliation) so it is never presented as written.
 */
export function ledgerRowToItem(row: ProgressLedgerRow, t: Translate): OperationItem {
  const base = { id: row.id, label: row.videoId };
  switch (row.status) {
    case "APPLYING":
      return { ...base, status: "running" };
    case "SUCCESS":
    case "DRY_RUN_COMPLETE":
      return { ...base, status: "done" };
    case "FAILED":
    case "CONFLICT":
    case "ABORTED_SYSTEMIC":
      return { ...base, status: "failed", detail: row.error ?? row.status };
    case "CANCELLED":
      return { ...base, status: "skipped", detail: t("batches.progress.cancelled") };
    case "UNKNOWN":
      return { ...base, status: "failed", detail: row.error ?? t("batches.progress.unknownOutcome") };
    default:
      return { ...base, status: "pending" };
  }
}

export function deriveBatchStage(rows: ProgressLedgerRow[], dryRun: boolean, t: Translate): string {
  if (dryRun) return t("batches.progress.stageDryRun");
  if (rows.some((row) => row.status === "APPLYING")) return t("batches.progress.stageWriting");
  if (rows.some((row) => row.status === "PENDING")) return t("batches.progress.stagePreparing");
  return t("batches.progress.stageWriting");
}

export function summarizeBatchRows(rows: ProgressLedgerRow[], dryRun: boolean, t: Translate): string {
  const ok = rows.filter((row) => row.status === "SUCCESS" || row.status === "DRY_RUN_COMPLETE").length;
  const notOk = rows.filter((row) => ["FAILED", "CONFLICT", "ABORTED_SYSTEMIC", "UNKNOWN"].includes(row.status)).length;
  const cancelledCount = rows.filter((row) => row.status === "CANCELLED").length;
  const waiting = rows.length - ok - notOk - cancelledCount;
  // Each part is a whole clause; the list of clauses is joined by the list separator key.
  const parts = [t(dryRun ? "batches.progress.summaryChecked" : "batches.progress.summaryWritten", { count: ok })];
  if (notOk) parts.push(t("batches.progress.summaryNotWritten", { count: notOk }));
  if (cancelledCount) parts.push(t("batches.progress.summaryCancelled", { count: cancelledCount }));
  if (waiting) parts.push(t("batches.progress.summaryWaiting", { count: waiting }));
  return t("batches.progress.summary", { parts: parts.join(t("batches.progress.listSeparator")) });
}
