import { DomainError, TERMINAL_LEDGER_STATUSES, type Batch, type LedgerRow } from "./contracts";
import { isApprovalStillValid } from "./services";
import type { SendableChangeCandidate } from "./adapters/store";

/**
 * BL-124 / ADR 0020: the server half of the one-click "send approved changes" button.
 *
 * It only SELECTS and CREATES: from a stored change set it picks the sendable changes (approved + valid +
 * no conflict + the frozen approval still matching the proposed value) and creates a LIVE batch from them
 * through the existing `createBatch`. It never executes anything and never references a write executor --
 * the write itself still goes through the existing execute route / `executeBatch` / the single write
 * gateway, with every safeguard unchanged (`write-path-inventory.test.ts` stays green without a new entry).
 */
export type SendApprovedDeps = {
  /** The persisted Settings-tab Live writes toggle. Read FIRST: with it off nothing is created. */
  isLiveWritesEnabled(): Promise<boolean>;
  batches: {
    createBatch(input: {
      channelId: string;
      selections: Array<{ videoId: string; changeIds: string[] }>;
      dryRun: boolean;
    }): Promise<Batch>;
    listBatchesByChannel(channelId: string): Promise<Batch[]>;
    listLedgerRows(batchId: string): Promise<LedgerRow[]>;
  };
  changeSets: {
    getChangeSet(changeSetId: string): Promise<{ id: string; channelId: string } | null>;
    listChanges(changeSetId: string): Promise<SendableChangeCandidate[]>;
  };
};

export type SendApprovedResult = { batch: Batch; changeCount: number; videoCount: number };

export function selectSendableChanges(changes: SendableChangeCandidate[]): SendableChangeCandidate[] {
  return changes.filter(
    (change) =>
      change.approvalStatus === "approved" &&
      change.validationStatus === "valid" &&
      change.conflictStatus === "none" &&
      isApprovalStillValid(change)
  );
}

/** A change counts as already written when a SUCCESS row of a real (non-dry-run) batch is at least as new as the change's last update. */
function excludeAlreadyWritten(changes: SendableChangeCandidate[], writtenAtByChangeId: Map<string, number>): SendableChangeCandidate[] {
  return changes.filter((change) => {
    const writtenAt = writtenAtByChangeId.get(change.id);
    return writtenAt === undefined || writtenAt < Date.parse(change.updatedAt);
  });
}

export function createSendApprovedServices(deps: SendApprovedDeps) {
  // Creation is serialized per channel in this process (the server is one Node process), so two clicks
  // arriving together cannot both pass the "already in flight" check before either has created its batch.
  const tails = new Map<string, Promise<unknown>>();

  function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  }

  async function findInFlightBatchId(channelId: string, changeIds: Set<string>): Promise<string | null> {
    const batches = await deps.batches.listBatchesByChannel(channelId);
    for (const batch of batches) {
      if (batch.dryRun || (batch.status !== "PENDING" && batch.status !== "RUNNING")) continue;
      const rows = await deps.batches.listLedgerRows(batch.id);
      const holdsOne = rows.some(
        (row) => !TERMINAL_LEDGER_STATUSES.has(row.status) && row.changeIds.some((id) => changeIds.has(id))
      );
      if (holdsOne) return batch.id;
    }
    return null;
  }

  async function writtenAtByChangeId(channelId: string): Promise<Map<string, number>> {
    const writtenAt = new Map<string, number>();
    for (const batch of await deps.batches.listBatchesByChannel(channelId)) {
      if (batch.dryRun) continue;
      for (const row of await deps.batches.listLedgerRows(batch.id)) {
        if (row.status !== "SUCCESS") continue;
        const at = Date.parse(row.updatedAt);
        for (const id of row.changeIds) writtenAt.set(id, Math.max(writtenAt.get(id) ?? 0, at));
      }
    }
    return writtenAt;
  }

  async function createLiveBatchForChangeSet(input: { channelId: string; changeSetId: string }): Promise<SendApprovedResult> {
    // AC-SEND-02: with Live writes off this refuses before touching anything, so no batch row is left behind
    // (the execute route re-checks the same toggle independently, Layer 1 and Layer 2).
    if (!(await deps.isLiveWritesEnabled())) {
      throw new DomainError({
        code: "live_writes_disabled",
        message: "Live writes is off -- nothing was sent. Turn on \"Live writes\" in Settings first.",
      });
    }

    return serialized(input.channelId, async () => {
      const changeSet = await deps.changeSets.getChangeSet(input.changeSetId);
      if (!changeSet || changeSet.channelId !== input.channelId) {
        throw new DomainError({
          code: "not_found",
          message: `Change set ${input.changeSetId} not found for this channel`,
          details: { changeSetId: input.changeSetId },
        });
      }

      // Changes a real batch already wrote (and that were not edited since) are not sent a second time: that would only spend quota and a backup
      // to hit the pre-write conflict check against the value that is already live (AC-SEND-13).
      const sendable = excludeAlreadyWritten(
        selectSendableChanges(await deps.changeSets.listChanges(input.changeSetId)),
        await writtenAtByChangeId(input.channelId)
      );
      if (sendable.length === 0) {
        throw new DomainError({
          code: "send_nothing_to_send",
          message: "This change set has no approved, valid, conflict-free changes left to send (changes already written are not sent again).",
          details: { changeSetId: input.changeSetId },
        });
      }

      const inFlightBatchId = await findInFlightBatchId(input.channelId, new Set(sendable.map((change) => change.id)));
      if (inFlightBatchId) {
        throw new DomainError({
          code: "send_already_in_progress",
          message: "These changes are already part of a live batch that has not finished.",
          details: { batchId: inFlightBatchId, changeSetId: input.changeSetId },
        });
      }

      const byVideo = new Map<string, string[]>();
      for (const change of sendable) {
        const ids = byVideo.get(change.videoId) ?? [];
        ids.push(change.id);
        byVideo.set(change.videoId, ids);
      }
      const batch = await deps.batches.createBatch({
        channelId: input.channelId,
        selections: [...byVideo.entries()].map(([videoId, changeIds]) => ({ videoId, changeIds })),
        dryRun: false,
      });
      return { batch, changeCount: sendable.length, videoCount: byVideo.size };
    });
  }

  return { createLiveBatchForChangeSet };
}

export type SendApprovedServices = ReturnType<typeof createSendApprovedServices>;
