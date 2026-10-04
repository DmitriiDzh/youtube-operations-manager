import type {
  DraftPurgePlan,
  RetentionBatchFacts,
  RetentionChangeSetFacts,
  RetentionLedgerRowFacts,
  WriteLogPurgePlan,
} from "./contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

function isOlderThan(moment: Date, now: Date, days: number): boolean {
  return now.getTime() - moment.getTime() >= days * DAY_MS;
}

/**
 * Which change sets may be deleted now. Pure: facts in, ids out.
 *
 * - `in_review` -> never.
 * - `rejected` -> yes, once older than `draftRetentionDays`.
 * - `approved` / `partially_approved` -> only if EVERY approved change appears in at least one ledger row that is SUCCESS in a real
 *   (non-dry-run) batch. A later success therefore supersedes an earlier failed attempt; a change that is only in FAILED / CONFLICT / UNKNOWN /
 *   APPLYING / CANCELLED / PENDING / AWAITING_EXECUTION rows (or in none) keeps the whole set.
 * - Age is the latest of the set's own update time, its changes' update times and the update times of the ledger rows that carry its changes,
 *   so a set is never deleted on the strength of an old creation date while something about it just happened.
 */
export function planDraftPurge(
  changeSets: RetentionChangeSetFacts[],
  ledgerRows: RetentionLedgerRowFacts[],
  now: Date,
  draftRetentionDays: number
): DraftPurgePlan {
  const rowsByChangeId = new Map<string, RetentionLedgerRowFacts[]>();
  for (const row of ledgerRows) {
    for (const changeId of row.changeIds) {
      const list = rowsByChangeId.get(changeId) ?? [];
      list.push(row);
      rowsByChangeId.set(changeId, list);
    }
  }

  const changeSetIds: string[] = [];
  for (const set of changeSets) {
    if (set.status === "in_review") continue;

    let latest = set.updatedAt.getTime();
    for (const change of set.changes) {
      latest = Math.max(latest, change.updatedAt.getTime());
      for (const row of rowsByChangeId.get(change.id) ?? []) latest = Math.max(latest, row.updatedAt.getTime());
    }
    if (!isOlderThan(new Date(latest), now, draftRetentionDays)) continue;

    if (set.status === "rejected") {
      changeSetIds.push(set.id);
      continue;
    }

    const approved = set.changes.filter((change) => change.approvalStatus === "approved");
    if (approved.length === 0) continue;
    const everyApprovedWritten = approved.every((change) =>
      (rowsByChangeId.get(change.id) ?? []).some((row) => row.status === "SUCCESS" && !row.batchDryRun)
    );
    if (everyApprovedWritten) changeSetIds.push(set.id);
  }
  return { changeSetIds };
}

/**
 * Which batches (with their ledger rows, attempts and audit events) may be deleted now: COMPLETED, every row SUCCESS or DRY_RUN_COMPLETE,
 * completed more than `writeLogRetentionDays` ago, and none of its rows' changes still sits in a surviving change set (otherwise that set
 * would lose the proof that it was written and never become settled). A batch with any FAILED / CONFLICT / CANCELLED / ABORTED_SYSTEMIC /
 * UNKNOWN row is kept until the owner decides.
 */
export function planWriteLogPurge(
  batches: RetentionBatchFacts[],
  survivingChangeIds: ReadonlySet<string>,
  now: Date,
  writeLogRetentionDays: number
): WriteLogPurgePlan {
  const batchIds: string[] = [];
  for (const batch of batches) {
    if (batch.status !== "COMPLETED" || batch.completedAt === null) continue;
    if (!isOlderThan(batch.completedAt, now, writeLogRetentionDays)) continue;
    if (!batch.rows.every((row) => row.status === "SUCCESS" || row.status === "DRY_RUN_COMPLETE")) continue;
    if (batch.rows.some((row) => row.changeIds.some((id) => survivingChangeIds.has(id)))) continue;
    batchIds.push(batch.id);
  }
  return { batchIds };
}
