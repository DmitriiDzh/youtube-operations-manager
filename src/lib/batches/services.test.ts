// ---------------------------------------------------------------------------
// Acceptance matrix for this file (Step 1-2 of docs/DEVELOPMENT_PLAYBOOK.md §6.14),
// fixed BEFORE writing services.ts, directly from docs/acceptance/PHASE_5_ACCEPTANCE.md
// and the approved Slice 1/2 scope (Batch entity/immutable membership, per-video ledger,
// durable attempt-intent persistence, explicit state model, concurrency protection,
// approval/payload integrity re-check).
//
// AC-BATCH-01 / AC-BATCH-02 (membership frozen at creation):
//   Input: a batch created with 3 video selections.
//   Expected: exactly 3 ledger rows exist immediately, each with the exact changeIds
//   given at creation; no operation in this module can add, remove, or retarget a
//   ledger row afterward (there is no such function in services.ts).
//
// AC-LEDGER-01 (row creation, initial state PENDING):
//   Expected: every created ledger row has status PENDING and the correct batchId/videoId.
//   Prohibited: a ledger row for a video with zero changeIds; a per-change row.
//
// AC-MERGE-04 (part 1, at creation time -- see prepare-batch.test.ts for the send-time
// re-check, AC-BATCH-03): a change that is not approved+valid+non-conflicting, or that
// does not belong to the video it's selected under, must never be accepted into a batch.
//
// AC-CONCURRENCY-01 (no two batches write the same video concurrently):
//   Input: two different batches both target videoId "v1".
//   Expected: only the first caller to acquire the lock for "v1" succeeds; the second
//   call throws DomainError("video_locked") naming the holder. Releasing the lock allows
//   a subsequent acquisition to succeed.
//
// AC-CONCURRENCY-02 / AC-CONCURRENCY-03 (a batch cannot be executed twice concurrently):
//   Input: claimBatchExecution called twice for the same batch without an intervening
//   completeBatchExecution.
//   Expected: the first call succeeds (PENDING -> RUNNING); the second throws
//   DomainError("batch_already_running").
//   Note: this file's fake, synchronous, in-memory store proves the *business-rule*
//   behavior only. It cannot prove the claim is atomic under real concurrent I/O
//   interleaving -- that is proven separately, against a real SQLite database, by
//   src/lib/batches/concurrency.integration.test.ts (see that file for why).
//
// AC-ATTEMPT-03 (durable intent commit strictly before the network call):
//   Expected: beginAttempt's durable store write is observed (via a call-order log) to
//   complete before executor.attemptWrite is ever invoked, for every attempt.
//
// AC-ATTEMPT-02 (attempts independently queryable, distinguishable from ledger rows):
//   Input: v1 attempts twice (1 failure, 1 success), v2 attempts once (success).
//   Expected: listAttemptsForBatch returns 3 records total, correctly attributed by
//   ledgerRowId; listLedgerRows still returns exactly 2 rows (one per video) -- the
//   ledger-row count must never be inflated by attempt count.
//
// AC-ATTEMPT-01 (partial -- data model only, no retry policy in this slice):
//   Manually driving 3 sequential attempts (FAILED, FAILED, SUCCESS) via
//   executeSingleAttempt produces exactly 3 independently-queryable attempt records with
//   attemptNumber 1/2/3 and the correct outcome each, and exactly one ledger row. This
//   test proves the DATA MODEL can represent AC-ATTEMPT-01's fixture; it does not prove
//   an autonomous retry loop exists (there isn't one yet -- that is Slice 3's "retry
//   classification and bounded backoff").
//
// Ledger state-machine guard (INV-11/INV-12's "explicit state" requirement):
//   An illegal transition (e.g. SUCCESS -> APPLYING, or beginning an attempt on an
//   already-terminal row) must be rejected with DomainError("ledger_invalid_transition"),
//   never silently accepted or silently ignored.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import type {
  AttemptOutcome,
  BatchStatus,
  LedgerStatus,
  PendingChangeRecord,
  StoredAttemptRecord,
  StoredBatchRecord,
  StoredLedgerRowRecord,
} from "./contracts";
import { createBatchServices } from "./services";
import { createScriptedFakeWriteExecutor } from "./adapters/write-executor.fake";

function createFakeStore() {
  const batches = new Map<string, StoredBatchRecord>();
  const ledgerRows = new Map<string, StoredLedgerRowRecord>();
  const attempts = new Map<string, StoredAttemptRecord>();
  const locks = new Map<string, { batchId: string; ledgerRowId: string; lockedAt: Date }>();
  const changes = new Map<string, PendingChangeRecord>();
  const callLog: string[] = [];

  return {
    callLog,
    changes,
    /** Test-only helper: registers a changesets Change as approved/valid/non-conflicting. */
    registerApprovedChange(entry: { id: string; videoId: string }) {
      changes.set(entry.id, {
        id: entry.id,
        videoId: entry.videoId,
        language: "es",
        field: "title",
        baselineValue: "baseline",
        proposedValue: "proposed",
        approvedValue: "proposed",
        approvalStatus: "approved",
        validationStatus: "valid",
        conflictStatus: "none",
      });
    },
    async getChange(changeId: string) {
      return changes.get(changeId) ?? null;
    },
    async createBatchWithLedger(input: {
      id: string;
      channelId: string;
      concurrency: number;
      dryRun: boolean;
      ledgerRows: Array<{ id: string; videoId: string; changeIds: string[] }>;
    }) {
      const now = new Date();
      batches.set(input.id, {
        id: input.id,
        channelId: input.channelId,
        status: "PENDING",
        concurrency: input.concurrency,
        dryRun: input.dryRun,
        runId: null,
        createdAt: now,
        startedAt: null,
        completedAt: null,
      });
      for (const row of input.ledgerRows) {
        ledgerRows.set(row.id, {
          id: row.id,
          batchId: input.id,
          videoId: row.videoId,
          changeIds: row.changeIds,
          status: "PENDING",
          error: null,
          verificationResult: null,
          activeAttemptId: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    },
    async getBatch(batchId: string) {
      return batches.get(batchId) ?? null;
    },
    async listBatchesByChannel(channelId: string) {
      return [...batches.values()].filter((b) => b.channelId === channelId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    async listLedgerRowsByBatch(batchId: string) {
      return [...ledgerRows.values()].filter((row) => row.batchId === batchId);
    },
    async getLedgerRow(ledgerRowId: string) {
      return ledgerRows.get(ledgerRowId) ?? null;
    },
    async claimBatchExecution(batchId: string, runId: string) {
      const batch = batches.get(batchId);
      if (!batch || batch.status !== "PENDING") return false;
      batches.set(batchId, { ...batch, status: "RUNNING", runId, startedAt: new Date() });
      return true;
    },
    async markBatchTerminal(batchId: string, status: Extract<BatchStatus, "COMPLETED" | "ABORTED">) {
      const batch = batches.get(batchId);
      if (!batch) return;
      batches.set(batchId, { ...batch, status, completedAt: new Date() });
    },
    async acquireVideoExecutionLock(input: { videoId: string; batchId: string; ledgerRowId: string }) {
      const existing = locks.get(input.videoId);
      if (existing) {
        // Idempotent for the same owner -- mirrors src/lib/db.ts's acquireVideoExecutionLock.
        return existing.batchId === input.batchId && existing.ledgerRowId === input.ledgerRowId;
      }
      locks.set(input.videoId, {
        batchId: input.batchId,
        ledgerRowId: input.ledgerRowId,
        lockedAt: new Date(),
      });
      return true;
    },
    async releaseVideoExecutionLock(input: { videoId: string; batchId: string }) {
      const holder = locks.get(input.videoId);
      if (holder && holder.batchId === input.batchId) locks.delete(input.videoId);
    },
    async getVideoExecutionLockHolder(videoId: string) {
      return locks.get(videoId) ?? null;
    },
    async transitionLedgerRowStatus(input: {
      ledgerRowId: string;
      from: LedgerStatus[];
      to: LedgerStatus;
      error?: string | null;
      verificationResult?: unknown;
    }) {
      const row = ledgerRows.get(input.ledgerRowId);
      if (!row || !input.from.includes(row.status)) return false;
      ledgerRows.set(input.ledgerRowId, {
        ...row,
        status: input.to,
        error: input.error !== undefined ? input.error : row.error,
        verificationResult:
          input.verificationResult !== undefined ? input.verificationResult : row.verificationResult,
        updatedAt: new Date(),
      });
      return true;
    },
    async beginAttemptIntent(input: {
      id: string;
      ledgerRowId: string;
      attemptNumber: number;
      payloadSnapshot: unknown;
    }) {
      // Mirrors src/lib/db.ts's beginAttemptIntent: atomic claim-then-insert, so a
      // ledger row with an already-active (unresolved) attempt refuses a second one
      // rather than relying on attemptNumber collision detection after the fact.
      const row = ledgerRows.get(input.ledgerRowId);
      if (!row || row.activeAttemptId !== null) return false;

      ledgerRows.set(input.ledgerRowId, { ...row, activeAttemptId: input.id, updatedAt: new Date() });
      callLog.push(`intent:${input.ledgerRowId}:${input.attemptNumber}`);
      attempts.set(input.id, {
        id: input.id,
        ledgerRowId: input.ledgerRowId,
        attemptNumber: input.attemptNumber,
        phase: "INTENDED",
        payloadSnapshot: input.payloadSnapshot,
        requestedAt: new Date(),
        outcome: null,
        outcomeDetail: null,
        resultAt: null,
      });
      return true;
    },
    async recordAttemptResult(input: {
      attemptId: string;
      outcome: AttemptOutcome;
      outcomeDetail: string | null;
    }) {
      const attempt = attempts.get(input.attemptId);
      if (!attempt || attempt.phase !== "INTENDED") return false;
      attempts.set(input.attemptId, {
        ...attempt,
        phase: "RESULT_RECORDED",
        outcome: input.outcome,
        outcomeDetail: input.outcomeDetail,
        resultAt: new Date(),
      });

      const row = ledgerRows.get(attempt.ledgerRowId);
      if (row && row.activeAttemptId === input.attemptId) {
        ledgerRows.set(attempt.ledgerRowId, { ...row, activeAttemptId: null, updatedAt: new Date() });
      }
      return true;
    },
    async listAttemptsByLedgerRow(ledgerRowId: string) {
      return [...attempts.values()]
        .filter((attempt) => attempt.ledgerRowId === ledgerRowId)
        .sort((a, b) => a.attemptNumber - b.attemptNumber);
    },
    async listAttemptsByBatch(batchId: string) {
      const rowIds = new Set(
        [...ledgerRows.values()].filter((row) => row.batchId === batchId).map((row) => row.id)
      );
      return [...attempts.values()].filter((attempt) => rowIds.has(attempt.ledgerRowId));
    },
    async getAttempt(attemptId: string) {
      return attempts.get(attemptId) ?? null;
    },
  };
}

// Slice 2 stubs -- none of the tests in this file exercise prepareBatchExecution's
// identity/fetch/backup/merge pipeline (that has its own dedicated acceptance matrix and
// fake wiring in prepare-batch.test.ts); these exist only so createBatchServices can be
// constructed here without throwing on missing dependencies.
function createUnusedDependencyStub(name: string) {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`${name} should not be called by any test in services.test.ts`);
      },
    }
  );
}

function createHarness() {
  const store = createFakeStore();
  let counter = 0;
  const services = createBatchServices({
    batchStore: store,
    changeSetStore: store,
    authResolver: createUnusedDependencyStub("authResolver") as never,
    writeContext: createUnusedDependencyStub("writeContext") as never,
    youtubeApi: createUnusedDependencyStub("youtubeApi") as never,
    backup: createUnusedDependencyStub("backup") as never,
    audit: { async record() {} },
    clock: { async wait() {} },
    idGenerator: () => `id-${++counter}`,
    logger: { info() {}, error() {} },
  });
  return { store, services };
}

/** Registers every selection's changes as approved/valid/non-conflicting, then creates
 * the batch -- keeps every test below focused on what it actually asserts, per
 * AC-MERGE-04's requirement that createBatch only ever accepts already-qualifying changes. */
async function createApprovedBatch(
  harness: ReturnType<typeof createHarness>,
  input: Parameters<ReturnType<typeof createBatchServices>["createBatch"]>[0]
) {
  for (const selection of input.selections) {
    for (const changeId of selection.changeIds) {
      harness.store.registerApprovedChange({ id: changeId, videoId: selection.videoId });
    }
  }
  return harness.services.createBatch(input);
}

test("AC-BATCH-01/02: batch creation freezes membership into one ledger row per video", async () => {
  const harness = createHarness();

  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [
      { videoId: "v1", changeIds: ["c1"] },
      { videoId: "v2", changeIds: ["c2", "c3"] },
      { videoId: "v3", changeIds: ["c4"] },
    ],
  });

  const rows = await harness.services.listLedgerRows(batch.id);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => [r.videoId, r.changeIds]).sort(),
    [
      ["v1", ["c1"]],
      ["v2", ["c2", "c3"]],
      ["v3", ["c4"]],
    ].sort()
  );
});

test("AC-LEDGER-01: every ledger row starts PENDING with no per-change duplication", async () => {
  const harness = createHarness();

  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [{ videoId: "v1", changeIds: ["c1", "c2"] }],
  });

  const rows = await harness.services.listLedgerRows(batch.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "PENDING");
  assert.deepEqual(rows[0].changeIds, ["c1", "c2"]);
});

test("batch creation rejects a duplicate videoId across selections (one ledger row per video, DEC-OQ-1)", async () => {
  const harness = createHarness();

  await assert.rejects(
    () =>
      createApprovedBatch(harness, {
        channelId: "UC_TEST",
        selections: [
          { videoId: "v1", changeIds: ["c1"] },
          { videoId: "v1", changeIds: ["c2"] },
        ],
      }),
    (error: unknown) => error instanceof DomainError && error.code === "batch_invalid_selection"
  );
});

test("AC-MERGE-04 (creation-time): a change that is not approved is rejected from the batch", async () => {
  const harness = createHarness();
  harness.store.changes.set("c1", {
    id: "c1",
    videoId: "v1",
    language: "es",
    field: "title",
    baselineValue: "b",
    proposedValue: "p",
    approvedValue: null,
    approvalStatus: "pending",
    validationStatus: "valid",
    conflictStatus: "none",
  });

  await assert.rejects(
    () => harness.services.createBatch({ channelId: "UC_TEST", selections: [{ videoId: "v1", changeIds: ["c1"] }] }),
    (error: unknown) => error instanceof DomainError && error.code === "change_approval_invalid"
  );
});

test("AC-MERGE-04 (creation-time): a change belonging to a different video is rejected", async () => {
  const harness = createHarness();
  harness.store.registerApprovedChange({ id: "c1", videoId: "v-other" });

  await assert.rejects(
    () => harness.services.createBatch({ channelId: "UC_TEST", selections: [{ videoId: "v1", changeIds: ["c1"] }] }),
    (error: unknown) => error instanceof DomainError && error.code === "batch_invalid_selection"
  );
});

test("AC-CONCURRENCY-01: a video lock held by one batch blocks acquisition by another", async () => {
  const harness = createHarness();

  const batchA = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [{ videoId: "v1", changeIds: ["c1"] }],
  });
  const batchB = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [{ videoId: "v1", changeIds: ["c2"] }],
  });
  const rowsA = await harness.services.listLedgerRows(batchA.id);
  const rowsB = await harness.services.listLedgerRows(batchB.id);

  await harness.services.acquireVideoLock({ batchId: batchA.id, ledgerRowId: rowsA[0].id, videoId: "v1" });

  await assert.rejects(
    () => harness.services.acquireVideoLock({ batchId: batchB.id, ledgerRowId: rowsB[0].id, videoId: "v1" }),
    (error: unknown) => error instanceof DomainError && error.code === "video_locked"
  );

  await harness.services.releaseVideoLock({ batchId: batchA.id, videoId: "v1" });
  await assert.doesNotReject(() =>
    harness.services.acquireVideoLock({ batchId: batchB.id, ledgerRowId: rowsB[0].id, videoId: "v1" })
  );
});

test("AC-CONCURRENCY-02/03: a batch cannot be claimed for execution twice without completing first", async () => {
  const harness = createHarness();

  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [{ videoId: "v1", changeIds: ["c1"] }],
  });

  await harness.services.claimBatchExecution(batch.id);

  await assert.rejects(
    () => harness.services.claimBatchExecution(batch.id),
    (error: unknown) => error instanceof DomainError && error.code === "batch_already_running"
  );

  await harness.services.completeBatchExecution(batch.id, "COMPLETED");
  const finalBatch = await harness.services.getBatch(batch.id);
  assert.equal(finalBatch.status, "COMPLETED");
});

test("AC-ATTEMPT-03: the attempt-intent record is durably committed before the executor is ever called", async () => {
  const harness = createHarness();

  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [{ videoId: "v1", changeIds: ["c1"] }],
  });
  const [row] = await harness.services.listLedgerRows(batch.id);
  await harness.services.transitionLedgerStatus(row.id, "AWAITING_EXECUTION");

  const executor = {
    async attemptWrite() {
      harness.store.callLog.push("network-call");
      return { outcome: "SUCCESS" as const };
    },
  };

  await harness.services.executeSingleAttempt(row.id, { title: "New Title" }, executor);

  assert.deepEqual(harness.store.callLog, ["intent:" + row.id + ":1", "network-call"]);
});

test("AC-ATTEMPT-02: attempts are independently queryable and never inflate the ledger-row count", async () => {
  const harness = createHarness();

  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [
      { videoId: "v1", changeIds: ["c1"] },
      { videoId: "v2", changeIds: ["c2"] },
    ],
  });
  const [rowV1, rowV2] = (await harness.services.listLedgerRows(batch.id)).sort((a, b) =>
    a.videoId.localeCompare(b.videoId)
  );
  await harness.services.transitionLedgerStatus(rowV1.id, "AWAITING_EXECUTION");
  await harness.services.transitionLedgerStatus(rowV2.id, "AWAITING_EXECUTION");

  const v1Executor = createScriptedFakeWriteExecutor([
    { outcome: "FAILED", detail: "503", classification: "transient" },
    { outcome: "SUCCESS" },
  ]);
  const v2Executor = createScriptedFakeWriteExecutor([{ outcome: "SUCCESS" }]);

  await harness.services.executeSingleAttempt(rowV1.id, { title: "T1" }, v1Executor);
  await harness.services.executeSingleAttempt(rowV1.id, { title: "T1" }, v1Executor);
  await harness.services.executeSingleAttempt(rowV2.id, { title: "T2" }, v2Executor);

  const allAttempts = await harness.services.listAttemptsForBatch(batch.id);
  assert.equal(allAttempts.length, 3);

  const ledgerRows = await harness.services.listLedgerRows(batch.id);
  assert.equal(ledgerRows.length, 2);
});

test("AC-ATTEMPT-01 (data model only): 3 sequential attempts produce 3 independently queryable records, 1 ledger row", async () => {
  const harness = createHarness();

  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [{ videoId: "v1", changeIds: ["c1"] }],
  });
  const [row] = await harness.services.listLedgerRows(batch.id);
  await harness.services.transitionLedgerStatus(row.id, "AWAITING_EXECUTION");

  const executor = createScriptedFakeWriteExecutor([
    { outcome: "FAILED", detail: "503", classification: "transient" },
    { outcome: "FAILED", detail: "503", classification: "transient" },
    { outcome: "SUCCESS" },
  ]);

  await harness.services.executeSingleAttempt(row.id, { title: "T" }, executor);
  await harness.services.executeSingleAttempt(row.id, { title: "T" }, executor);
  await harness.services.executeSingleAttempt(row.id, { title: "T" }, executor);

  const attempts = await harness.services.listAttempts(row.id);
  assert.equal(attempts.length, 3);
  assert.deepEqual(
    attempts.map((a) => [a.attemptNumber, a.outcome]),
    [
      [1, "FAILED"],
      [2, "FAILED"],
      [3, "SUCCESS"],
    ]
  );

  const ledgerRows = await harness.services.listLedgerRows(batch.id);
  assert.equal(ledgerRows.length, 1);
});

test("ledger state machine rejects an illegal transition (e.g. beginning an attempt on a terminal row)", async () => {
  const harness = createHarness();

  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [{ videoId: "v1", changeIds: ["c1"] }],
  });
  const [row] = await harness.services.listLedgerRows(batch.id);

  await harness.services.transitionLedgerStatus(row.id, "AWAITING_EXECUTION");
  await harness.services.transitionLedgerStatus(row.id, "APPLYING");
  await harness.services.transitionLedgerStatus(row.id, "SUCCESS");

  await assert.rejects(
    () => harness.services.beginAttempt(row.id, { title: "T" }),
    (error: unknown) => error instanceof DomainError && error.code === "ledger_invalid_transition"
  );

  await assert.rejects(
    () => harness.services.transitionLedgerStatus(row.id, "APPLYING"),
    (error: unknown) => error instanceof DomainError && error.code === "ledger_invalid_transition"
  );
});

test("completing an attempt twice is rejected (result phase is write-once)", async () => {
  const harness = createHarness();

  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [{ videoId: "v1", changeIds: ["c1"] }],
  });
  const [row] = await harness.services.listLedgerRows(batch.id);
  await harness.services.transitionLedgerStatus(row.id, "AWAITING_EXECUTION");
  const { attemptId } = await harness.services.beginAttempt(row.id, { title: "T" });

  await harness.services.completeAttempt(attemptId, "SUCCESS", null);

  await assert.rejects(
    () => harness.services.completeAttempt(attemptId, "FAILED", "duplicate"),
    (error: unknown) => error instanceof DomainError && error.code === "attempt_already_resolved"
  );
});

// ---------------------------------------------------------------------------
// Regression tests added after the 2026-09-17 Foundation safety verification.
// See the verification report for the two issues these close:
//   1. Attempt concurrency: beginAttempt must never allow a second active (unresolved)
//      attempt to exist for the same ledger row -- previously nothing enforced this at
//      the service layer at all (only a UNIQUE constraint on attempt_number, which two
//      racing callers with a stale count-based read could each satisfy with a different
//      number, leaving two simultaneously "active" attempts).
//   2. Lock recovery: acquireVideoLock must be idempotent when the exact same
//      batch+ledger row re-requests a lock it already holds (needed for a future crash-
//      recovery/resume flow to safely resume without producing a spurious conflict
//      against itself), while still failing closed against any other batch/ledger row.
// ---------------------------------------------------------------------------

test("REGRESSION: beginAttempt rejects a second active attempt while the first is still unresolved", async () => {
  const harness = createHarness();

  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [{ videoId: "v1", changeIds: ["c1"] }],
  });
  const [row] = await harness.services.listLedgerRows(batch.id);
  await harness.services.transitionLedgerStatus(row.id, "AWAITING_EXECUTION");

  const first = await harness.services.beginAttempt(row.id, { title: "T1" });
  assert.equal(first.attemptNumber, 1);

  await assert.rejects(
    () => harness.services.beginAttempt(row.id, { title: "T2" }),
    (error: unknown) => error instanceof DomainError && error.code === "attempt_already_active"
  );

  // Completing the first attempt frees the slot -- a new attempt is then allowed, and
  // gets the next sequential attemptNumber.
  await harness.services.completeAttempt(first.attemptId, "FAILED", "503");
  const second = await harness.services.beginAttempt(row.id, { title: "T2" });
  assert.equal(second.attemptNumber, 2);

  const attempts = await harness.services.listAttempts(row.id);
  assert.equal(attempts.length, 2);
});

test("REGRESSION: reacquiring a video lock already held by the same batch/ledger row is idempotent", async () => {
  const harness = createHarness();

  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [{ videoId: "v1", changeIds: ["c1"] }],
  });
  const [row] = await harness.services.listLedgerRows(batch.id);

  await harness.services.acquireVideoLock({ batchId: batch.id, ledgerRowId: row.id, videoId: "v1" });

  // Same owner, same video: must succeed silently (simulates a resume attempt after a
  // crash, before Slice 3's full recovery logic exists), not throw video_locked.
  await assert.doesNotReject(() =>
    harness.services.acquireVideoLock({ batchId: batch.id, ledgerRowId: row.id, videoId: "v1" })
  );

  // A different batch/ledger row must still be rejected -- idempotency for the true
  // owner must never widen into a general bypass of exclusivity.
  const otherBatch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [{ videoId: "v2", changeIds: ["c2"] }],
  });
  const [otherRow] = await harness.services.listLedgerRows(otherBatch.id);
  await assert.rejects(
    () => harness.services.acquireVideoLock({ batchId: otherBatch.id, ledgerRowId: otherRow.id, videoId: "v1" }),
    (error: unknown) => error instanceof DomainError && error.code === "video_locked"
  );
});

test("listBatchesByChannel only returns batches for that channel; requireBatchForChannel fails closed on a cross-channel batchId (AGENTS.md §F)", async () => {
  const harness = createHarness();

  const batchOnChannelA = await createApprovedBatch(harness, {
    channelId: "UC_CHANNEL_A",
    selections: [{ videoId: "v1", changeIds: ["c1"] }],
  });
  const batchOnChannelB = await createApprovedBatch(harness, {
    channelId: "UC_CHANNEL_B",
    selections: [{ videoId: "v2", changeIds: ["c2"] }],
  });

  const channelABatches = await harness.services.listBatchesByChannel("UC_CHANNEL_A");
  assert.equal(channelABatches.length, 1);
  assert.equal(channelABatches[0]!.id, batchOnChannelA.id);

  const channelBBatches = await harness.services.listBatchesByChannel("UC_CHANNEL_B");
  assert.equal(channelBBatches.length, 1);
  assert.equal(channelBBatches[0]!.id, batchOnChannelB.id);

  // Fetching channel B's real batch through channel A's URL segment must fail closed --
  // it must never silently return another channel's batch just because the batchId is
  // otherwise valid.
  await assert.rejects(
    () => harness.services.requireBatchForChannel("UC_CHANNEL_A", batchOnChannelB.id),
    (error: unknown) => error instanceof DomainError && error.code === "batch_not_found"
  );

  const correct = await harness.services.requireBatchForChannel("UC_CHANNEL_B", batchOnChannelB.id);
  assert.equal(correct.id, batchOnChannelB.id);
});
