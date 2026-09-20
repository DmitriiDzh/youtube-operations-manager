import { randomUUID } from "node:crypto";
import {
  acquireVideoExecutionLock,
  beginAttemptIntent,
  claimBatchExecution,
  createBatchWithLedger,
  getStoredAttempt,
  getStoredBatch,
  getStoredChangeById,
  getStoredLedgerRow,
  getVideoExecutionLockHolder,
  listStoredAttemptsByBatch,
  listStoredAttemptsByLedgerRow,
  listStoredBatchesByChannel,
  listStoredLedgerRowsByBatch,
  markBatchTerminal,
  recordAttemptResult,
  releaseVideoExecutionLock,
  transitionLedgerRowStatus,
} from "@/lib/db";
import type { PendingChangeRecord } from "../contracts";

export function createBatchStoreAdapter() {
  return {
    createBatchWithLedger,
    getBatch: getStoredBatch,
    listBatchesByChannel: listStoredBatchesByChannel,
    listLedgerRowsByBatch: listStoredLedgerRowsByBatch,
    getLedgerRow: getStoredLedgerRow,
    claimBatchExecution,
    markBatchTerminal,
    acquireVideoExecutionLock,
    releaseVideoExecutionLock,
    getVideoExecutionLockHolder,
    transitionLedgerRowStatus,
    beginAttemptIntent,
    recordAttemptResult,
    listAttemptsByLedgerRow: listStoredAttemptsByLedgerRow,
    listAttemptsByBatch: listStoredAttemptsByBatch,
    getAttempt: getStoredAttempt,
  };
}

export function createIdGenerator() {
  return () => randomUUID();
}

/**
 * Deliberately narrow: batches/ only ever needs to re-check the exact fields relevant to
 * approval/payload integrity (AC-BATCH-03) -- see PendingChangeRecord's own comment for
 * why this doesn't just import changesets' own (wider) Change type.
 */
export function createChangeSetStoreAdapter() {
  return {
    async getChange(changeId: string): Promise<PendingChangeRecord | null> {
      const change = await getStoredChangeById(changeId);
      if (!change) return null;

      return {
        id: change.id,
        videoId: change.videoId,
        language: change.language,
        field: change.field,
        baselineValue: change.baselineValue,
        proposedValue: change.proposedValue,
        approvedValue: change.approvedValue,
        approvalStatus: change.approvalStatus,
        validationStatus: change.validationStatus,
        conflictStatus: change.conflictStatus,
        changeType: change.changeType,
      };
    },
  };
}
