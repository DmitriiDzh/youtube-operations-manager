/**
 * Retention of settled drafts and of the write log (BL-125, `docs/roadmap/plans/DRAFT_SEND_AND_RETENTION_PLAN.md`; owner decisions 2026-10-04).
 *
 * "Settled" means a decision was made AND carried out: a rejected change set, or an approved one whose every approved change was written to YouTube
 * and verified (a ledger row of a real, non-dry-run batch in status SUCCESS -- the executor reaches SUCCESS only after the read-back verification).
 * Anything still in review, and anything that failed, conflicted, was cancelled or is still running, is never deleted automatically.
 */

export type RetentionChangeSetStatus = "in_review" | "approved" | "partially_approved" | "rejected";

export type RetentionChangeFacts = {
  id: string;
  approvalStatus: "pending" | "approved" | "rejected";
  updatedAt: Date;
};

export type RetentionChangeSetFacts = {
  id: string;
  status: RetentionChangeSetStatus;
  updatedAt: Date;
  changes: RetentionChangeFacts[];
};

export type RetentionLedgerRowFacts = {
  id: string;
  batchId: string;
  status: string;
  changeIds: string[];
  updatedAt: Date;
  /** The owning batch is a dry run: it never wrote anything, so it cannot settle a change. */
  batchDryRun: boolean;
};

export type RetentionBatchFacts = {
  id: string;
  status: string;
  completedAt: Date | null;
  rows: Array<{ status: string; changeIds: string[] }>;
};

export type DraftPurgePlan = { changeSetIds: string[] };
export type WriteLogPurgePlan = { batchIds: string[] };

export type RetentionSweepResult = {
  channelId: string;
  purgedChangeSets: number;
  purgedChanges: number;
  purgedProvenance: number;
  purgedBatches: number;
};
