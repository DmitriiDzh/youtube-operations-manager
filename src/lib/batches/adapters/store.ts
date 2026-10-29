import {
  acquireVideoExecutionLock,
  beginAttemptIntent,
  claimBatchExecution,
  createBatchWithLedger,
  getStoredAttempt,
  getStoredBatch,
  getStoredChangeById,
  getStoredChangeSet,
  listStoredChangesByChangeSet,
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
import { createIdGenerator, type PendingChangeRecord } from "../contracts";

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

export { createIdGenerator };

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

/**
 * Read-only view of a stored change set for the one-click send (ADR 0020): which channel owns it and
 * every one of its changes (no paging -- the selection is made on the server, never from a client list).
 */
export function createChangeSetReaderAdapter() {
  return {
    /** BL-232: the change set a change belongs to (null when the change is unknown). */
    async changeSetIdOf(changeId: string): Promise<string | null> {
      return (await getStoredChangeById(changeId))?.changeSetId ?? null;
    },
    async getChangeSet(changeSetId: string): Promise<{ id: string; channelId: string; source: string; createdAt: string } | null> {
      const changeSet = await getStoredChangeSet(changeSetId);
      return changeSet ? { id: changeSet.id, channelId: changeSet.channelId, source: changeSet.source, createdAt: changeSet.createdAt.toISOString() } : null;
    },
    async listChanges(changeSetId: string): Promise<SendableChangeCandidate[]> {
      const stored = await listStoredChangesByChangeSet(changeSetId);
      return stored.map((change) => ({
        id: change.id,
        videoId: change.videoId,
        language: change.language,
        field: change.field,
        changeType: change.changeType,
        approvalStatus: change.approvalStatus,
        validationStatus: change.validationStatus,
        conflictStatus: change.conflictStatus,
        approvedValue: change.approvedValue,
        proposedValue: change.proposedValue,
        updatedAt: change.updatedAt.toISOString(),
      }));
    },
  };
}

export type SendableChangeCandidate = {
  id: string;
  videoId: string;
  /** BL-198: the target, to find collisions between change sets (absent only in older test fixtures). */
  language?: string;
  field?: "title" | "description";
  changeType?: string;
  /** BL-198: the channel's last synced copy already holds the approved value (a delete: the language is gone). */
  remoteHolds?: boolean;
  approvalStatus: string;
  validationStatus: string;
  conflictStatus: string;
  approvedValue: string | null;
  proposedValue: string;
  /** ISO time of the change's last update -- a SUCCESS ledger row older than this does not cover its current value. */
  updatedAt: string;
};
