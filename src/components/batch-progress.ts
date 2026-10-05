import type { OperationItem } from "./operation-progress";

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
export function ledgerRowToItem(row: ProgressLedgerRow): OperationItem {
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
      return { ...base, status: "skipped", detail: "Cancelled" };
    case "UNKNOWN":
      return { ...base, status: "failed", detail: row.error ?? "UNKNOWN — outcome not confirmed" };
    default:
      return { ...base, status: "pending" };
  }
}

export function deriveBatchStage(rows: ProgressLedgerRow[], dryRun: boolean): string {
  if (dryRun) return "Dry run: checking identity, backup and conflicts — nothing is written";
  if (rows.some((row) => row.status === "APPLYING")) return "Writing to YouTube — each video is backed up and verified";
  if (rows.some((row) => row.status === "PENDING")) return "Preparing: identity, backup and conflict checks";
  return "Writing to YouTube — each video is backed up and verified";
}

export function summarizeBatchRows(rows: ProgressLedgerRow[], dryRun: boolean): string {
  const ok = rows.filter((row) => row.status === "SUCCESS" || row.status === "DRY_RUN_COMPLETE").length;
  const notOk = rows.filter((row) => ["FAILED", "CONFLICT", "ABORTED_SYSTEMIC", "UNKNOWN"].includes(row.status)).length;
  const cancelledCount = rows.filter((row) => row.status === "CANCELLED").length;
  const waiting = rows.length - ok - notOk - cancelledCount;
  const parts = [`${ok} ${dryRun ? "checked" : "written"}`];
  if (notOk) parts.push(`${notOk} not written (see the batch table)`);
  if (cancelledCount) parts.push(`${cancelledCount} cancelled`);
  if (waiting) parts.push(`${waiting} still waiting`);
  return `${parts.join(", ")}.`;
}
