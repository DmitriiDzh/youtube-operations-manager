// BL-124 / ADR 0020 -- docs/acceptance/BL124_SEND_APPROVED_ACCEPTANCE.md, criteria AC-SEND-01/03/04/05/06.
// Expected values are the hand-computed ones from that document's fixture F, not read back from the code.

import assert from "node:assert/strict";
import test from "node:test";
import type { Batch, LedgerRow, LedgerStatus } from "./contracts";
import { DomainError } from "./contracts";
import type { SendableChangeCandidate } from "./adapters/store";
import { createSendApprovedServices } from "./send-approved";

function candidate(partial: Partial<SendableChangeCandidate> & { id: string; videoId: string }): SendableChangeCandidate {
  return {
    approvalStatus: "approved",
    validationStatus: "valid",
    conflictStatus: "none",
    approvedValue: "value",
    proposedValue: "value",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...partial,
  };
}

/** Fixture F of the acceptance document. */
function fixtureF(): SendableChangeCandidate[] {
  return [
    candidate({ id: "c1", videoId: "v1" }),
    candidate({ id: "c2", videoId: "v1" }),
    candidate({ id: "c3", videoId: "v2" }),
    candidate({ id: "c4", videoId: "v2", approvalStatus: "pending", approvedValue: null }),
    candidate({ id: "c5", videoId: "v3", approvalStatus: "rejected", approvedValue: null }),
    candidate({ id: "c6", videoId: "v3", validationStatus: "invalid" }),
    candidate({ id: "c7", videoId: "v4", conflictStatus: "conflict" }),
    candidate({ id: "c8", videoId: "v5", approvedValue: "old approved text", proposedValue: "edited after approval" }),
  ];
}

function build(changesByChangeSet: Record<string, { channelId: string; changes: SendableChangeCandidate[] }>, liveWritesEnabled = true) {
  const batches: Batch[] = [];
  const rows = new Map<string, LedgerRow[]>();
  let counter = 0;
  let createCalls = 0;
  const service = createSendApprovedServices({
    isLiveWritesEnabled: async () => liveWritesEnabled,
    batches: {
      async createBatch(input) {
        createCalls++;
        // Make the second concurrent caller genuinely interleave with the first one's creation.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const batch: Batch = {
          id: `b${++counter}`,
          channelId: input.channelId,
          status: "PENDING",
          concurrency: 1,
          dryRun: input.dryRun,
          runId: null,
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
        };
        batches.push(batch);
        rows.set(
          batch.id,
          input.selections.map((selection, index) => ({
            id: `${batch.id}-r${index}`,
            batchId: batch.id,
            videoId: selection.videoId,
            changeIds: selection.changeIds,
            status: "PENDING" as LedgerStatus,
            error: null,
            verificationResult: null,
            activeAttemptId: null,
            createdAt: batch.createdAt,
            updatedAt: batch.createdAt,
          }))
        );
        return batch;
      },
      async listBatchesByChannel(channelId) {
        return batches.filter((batch) => batch.channelId === channelId);
      },
      async listLedgerRows(batchId) {
        return rows.get(batchId) ?? [];
      },
    },
    changeSets: {
      async getChangeSet(id) {
        const entry = changesByChangeSet[id];
        return entry ? { id, channelId: entry.channelId } : null;
      },
      async listChanges(id) {
        return changesByChangeSet[id]?.changes ?? [];
      },
    },
  });
  return { service, batches, rows, createCalls: () => createCalls };
}

async function rejection(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected the call to be refused");
}

test("AC-SEND-01: fixture F sends exactly c1, c2, c3 as one live batch with two ledger rows", async () => {
  const { service, batches, rows } = build({ CS1: { channelId: "UC_A", changes: fixtureF() } });

  const result = await service.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" });

  assert.equal(batches.length, 1);
  assert.equal(result.batch.dryRun, false);
  assert.equal(result.changeCount, 3);
  assert.equal(result.videoCount, 2);
  assert.deepEqual(
    rows.get(result.batch.id)!.map((row) => ({ videoId: row.videoId, changeIds: row.changeIds })),
    [
      { videoId: "v1", changeIds: ["c1", "c2"] },
      { videoId: "v2", changeIds: ["c3"] },
    ]
  );
});

test("AC-SEND-03: a change set with nothing sendable creates no batch and answers send_nothing_to_send", async () => {
  const onlyUnsendable = fixtureF().filter((change) => ["c4", "c5", "c6", "c7", "c8"].includes(change.id));
  const { service, batches } = build({ CS1: { channelId: "UC_A", changes: onlyUnsendable } });

  const error = await rejection(service.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" }));

  assert.equal(error.code, "send_nothing_to_send");
  assert.equal(batches.length, 0);
});

test("AC-SEND-04: a change set of another channel (or a missing one) is refused with not_found and creates no batch", async () => {
  const { service, batches } = build({ CS1: { channelId: "UC_A", changes: fixtureF() } });

  const wrongChannel = await rejection(service.createLiveBatchForChangeSet({ channelId: "UC_B", changeSetId: "CS1" }));
  const missing = await rejection(service.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS-NOPE" }));

  assert.equal(wrongChannel.code, "not_found");
  assert.equal(missing.code, "not_found");
  assert.equal(batches.length, 0);
});

test("AC-SEND-05: a change edited after approval (approvedValue differs from proposedValue) is never selected", async () => {
  const { service, rows } = build({
    CS1: {
      channelId: "UC_A",
      changes: [candidate({ id: "c1", videoId: "v1", approvedValue: "approved text", proposedValue: "changed afterwards" }), candidate({ id: "c2", videoId: "v2" })],
    },
  });

  const result = await service.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" });

  assert.deepEqual(rows.get(result.batch.id)!.map((row) => row.changeIds), [["c2"]]);
});

test("AC-SEND-06: two concurrent sends create exactly one batch; the second is told which one is in flight", async () => {
  const { service, batches } = build({ CS1: { channelId: "UC_A", changes: fixtureF() } });

  const [first, second] = await Promise.allSettled([
    service.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" }),
    service.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" }),
  ]);

  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(batches.length, 1);
  const error = (second as PromiseRejectedResult).reason as DomainError;
  assert.equal(error.code, "send_already_in_progress");
  assert.deepEqual(error.details, { batchId: "b1", changeSetId: "CS1" });
});

test("AC-SEND-06: once the first batch has finished (terminal), a new send creates a new batch", async () => {
  const { service, batches, rows } = build({ CS1: { channelId: "UC_A", changes: fixtureF() } });
  const first = await service.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" });

  // Finished, but nothing was written (every row FAILED): the changes still need sending, so a new batch is allowed.
  batches[0] = { ...batches[0]!, status: "COMPLETED" };
  rows.set(first.batch.id, rows.get(first.batch.id)!.map((row) => ({ ...row, status: "FAILED" as LedgerStatus })));

  const second = await service.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" });

  assert.equal(batches.length, 2);
  assert.equal(second.batch.id, "b2");
});

test("AC-SEND-06: a dry-run batch holding the same changes does not block a live send", async () => {
  const { service, batches, rows } = build({ CS1: { channelId: "UC_A", changes: fixtureF() } });
  batches.push({
    id: "dry",
    channelId: "UC_A",
    status: "PENDING",
    concurrency: 1,
    dryRun: true,
    runId: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  });
  rows.set("dry", [
    { id: "dry-r", batchId: "dry", videoId: "v1", changeIds: ["c1", "c2"], status: "PENDING", error: null, verificationResult: null, activeAttemptId: null, createdAt: "", updatedAt: "" },
  ]);

  const result = await service.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" });

  assert.equal(result.changeCount, 3);
});

test("AC-SEND-02: with Live writes off the send is refused with live_writes_disabled and nothing is created", async () => {
  const { service, batches, createCalls } = build({ CS1: { channelId: "UC_A", changes: fixtureF() } }, false);

  const error = await rejection(service.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" }));

  assert.equal(error.code, "live_writes_disabled");
  assert.equal(batches.length, 0);
  assert.equal(createCalls(), 0);
});

// AC-SEND-13 (added after independent review, 2026-10-04): changes a real batch already wrote are not sent a second time.
function markBatch(ctx: ReturnType<typeof build>, input: { id: string; dryRun: boolean; status: LedgerStatus; changeIds: string[]; at: string }) {
  ctx.batches.push({
    id: input.id,
    channelId: "UC_A",
    status: "COMPLETED",
    concurrency: 1,
    dryRun: input.dryRun,
    runId: null,
    createdAt: input.at,
    startedAt: null,
    completedAt: input.at,
  });
  ctx.rows.set(input.id, [
    { id: `${input.id}-r`, batchId: input.id, videoId: "v1", changeIds: input.changeIds, status: input.status, error: null, verificationResult: null, activeAttemptId: null, createdAt: input.at, updatedAt: input.at },
  ]);
}

test("AC-SEND-13: after a real batch wrote c1,c2,c3 (SUCCESS), sending the same set again has nothing to send", async () => {
  const ctx = build({ CS1: { channelId: "UC_A", changes: fixtureF() } });
  markBatch(ctx, { id: "done", dryRun: false, status: "SUCCESS", changeIds: ["c1", "c2", "c3"], at: "2026-10-02T00:00:00.000Z" });

  const error = await rejection(ctx.service.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" }));

  assert.equal(error.code, "send_nothing_to_send");
  assert.equal(ctx.batches.length, 1, "no new batch");
});

test("AC-SEND-13: only the changes not yet written are sent (c1,c2 written -> only c3)", async () => {
  const ctx = build({ CS1: { channelId: "UC_A", changes: fixtureF() } });
  markBatch(ctx, { id: "done", dryRun: false, status: "SUCCESS", changeIds: ["c1", "c2"], at: "2026-10-02T00:00:00.000Z" });

  const result = await ctx.service.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" });

  assert.equal(result.changeCount, 1);
  assert.deepEqual(ctx.rows.get(result.batch.id)!.map((row) => row.changeIds), [["c3"]]);
});

test("AC-SEND-13: a change edited and re-approved AFTER it was written is sent again; a dry-run SUCCESS or a FAILED row never counts as written", async () => {
  const changes = fixtureF();
  changes[0] = candidate({ id: "c1", videoId: "v1", updatedAt: "2026-10-05T00:00:00.000Z" }); // edited after the write below
  const ctx = build({ CS1: { channelId: "UC_A", changes } });
  markBatch(ctx, { id: "real", dryRun: false, status: "SUCCESS", changeIds: ["c1"], at: "2026-10-02T00:00:00.000Z" });
  markBatch(ctx, { id: "dry", dryRun: true, status: "SUCCESS", changeIds: ["c2"], at: "2026-10-04T00:00:00.000Z" });
  markBatch(ctx, { id: "failed", dryRun: false, status: "FAILED", changeIds: ["c3"], at: "2026-10-04T00:00:00.000Z" });

  const result = await ctx.service.createLiveBatchForChangeSet({ channelId: "UC_A", changeSetId: "CS1" });

  assert.equal(result.changeCount, 3, "c1 (edited later), c2 (only dry-run) and c3 (failed) are all sent");
});
