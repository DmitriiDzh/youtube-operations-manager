// ---------------------------------------------------------------------------
// Acceptance matrix (Step 1-2, docs/DEVELOPMENT_PLAYBOOK.md §6.14), fixed from the
// approved docs/acceptance/PHASE_5_ACCEPTANCE.md before writing executeBatch/
// executeWithRetry/reconcileAttempt:
//
// §0.E retry parameters: maxAttempts=4 (1 initial + 3 retries), only a `classification:
// "transient"` FAILED is retried; a `"permanent"` FAILED (or exhausted retries) is
// terminal FAILED immediately.
//
// AC-TIMEOUT-01 (§0.F, all four sub-cases):
//   1. First reconciliation read matches the requested value -> SUCCESS, no retry, Step
//      2 never reached.
//   2. First read matches baseline, second read ALSO matches baseline (two consistent
//      negative reads) -> UNKNOWN. Never a retry, even though two reads were spent.
//   3. First read matches baseline (stale), second read matches requested -> SUCCESS.
//   4. First read matches baseline, second read is inconsistent/diverged -> UNKNOWN.
//
// AC-TIMEOUT-02 / §0.F Step 4: resolveUnknownLedgerRow re-runs the FULL safety pipeline
// (approval re-check + fresh fetch + conflict detection), never a bare resend -- if the
// remote state has diverged in the interim, it is CONFLICT, not a blind retry of the
// stale payload.
//
// AC-VERIFY-01/AC-CONFLICT-02: a 200-equivalent SUCCESS response is not trusted on its
// own -- a post-write verification mismatch is FAILED, never SUCCESS.
// AC-VERIFY-02: requested/confirmed/timestamp are all present on a genuine SUCCESS.
//
// AC-AUDIT-05: a reconciliation-confirmed SUCCESS records ownResponseObserved: false; an
// ordinary own-response SUCCESS records ownResponseObserved: true. The two are never
// conflated at the attempt-evidence level even though both reach ledger-level SUCCESS.
//
// AC-ISOLATION-01: one video's FAILED does not stop the rest of the batch.
// AC-ISOLATION-02/quota: a `systemic: true` FAILED halts all remaining not-yet-attempted
// rows (ABORTED_SYSTEMIC) without touching already-completed ones.
// AC-ISOLATION-03: a downloadable error report lists every non-successful item.
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
  WriteExecutor,
  WriteExecutorResult,
} from "./contracts";
import { createBatchServices } from "./services";

function createFakeStore() {
  const batches = new Map<string, StoredBatchRecord>();
  const ledgerRows = new Map<string, StoredLedgerRowRecord>();
  const attempts = new Map<string, StoredAttemptRecord>();
  const locks = new Map<string, { batchId: string; ledgerRowId: string; lockedAt: Date }>();
  const changes = new Map<string, PendingChangeRecord>();

  return {
    changes,
    ledgerRows,
    registerApprovedChange(entry: Partial<PendingChangeRecord> & { id: string; videoId: string }) {
      const proposedValue = entry.proposedValue ?? "New Value";
      changes.set(entry.id, {
        id: entry.id,
        videoId: entry.videoId,
        language: entry.language ?? "es",
        field: entry.field ?? "title",
        baselineValue: entry.baselineValue ?? "",
        proposedValue,
        // Defaults to matching proposedValue (i.e. "approved and unedited since") --
        // a test exercising AC-BATCH-03 sub-case (c) passes an explicit mismatched
        // approvedValue to simulate an edit-after-approval.
        approvedValue: entry.approvedValue !== undefined ? entry.approvedValue : proposedValue,
        approvalStatus: entry.approvalStatus ?? "approved",
        validationStatus: entry.validationStatus ?? "valid",
        conflictStatus: entry.conflictStatus ?? "none",
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
      if (existing) return existing.batchId === input.batchId && existing.ledgerRowId === input.ledgerRowId;
      locks.set(input.videoId, { batchId: input.batchId, ledgerRowId: input.ledgerRowId, lockedAt: new Date() });
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
        verificationResult: input.verificationResult !== undefined ? input.verificationResult : row.verificationResult,
        updatedAt: new Date(),
      });
      return true;
    },
    async beginAttemptIntent(input: { id: string; ledgerRowId: string; attemptNumber: number; payloadSnapshot: unknown }) {
      const row = ledgerRows.get(input.ledgerRowId);
      if (!row || row.activeAttemptId !== null) return false;
      ledgerRows.set(input.ledgerRowId, { ...row, activeAttemptId: input.id, updatedAt: new Date() });
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
    async recordAttemptResult(input: { attemptId: string; outcome: AttemptOutcome; outcomeDetail: string | null }) {
      const attempt = attempts.get(input.attemptId);
      if (!attempt || attempt.phase !== "INTENDED") return false;
      attempts.set(input.attemptId, { ...attempt, phase: "RESULT_RECORDED", outcome: input.outcome, outcomeDetail: input.outcomeDetail, resultAt: new Date() });
      const row = ledgerRows.get(attempt.ledgerRowId);
      if (row && row.activeAttemptId === input.attemptId) {
        ledgerRows.set(attempt.ledgerRowId, { ...row, activeAttemptId: null, updatedAt: new Date() });
      }
      return true;
    },
    async listAttemptsByLedgerRow(ledgerRowId: string) {
      return [...attempts.values()].filter((a) => a.ledgerRowId === ledgerRowId).sort((a, b) => a.attemptNumber - b.attemptNumber);
    },
    async listAttemptsByBatch(batchId: string) {
      const rowIds = new Set([...ledgerRows.values()].filter((r) => r.batchId === batchId).map((r) => r.id));
      return [...attempts.values()].filter((a) => rowIds.has(a.ledgerRowId));
    },
    async getAttempt(attemptId: string) {
      return attempts.get(attemptId) ?? null;
    },
  };
}

type Fixture = { snippet: Record<string, unknown>; localizations: Record<string, { title: string; description: string }> };

function createHarness(options: {
  freshSequenceByVideoId?: Record<string, Array<Fixture | null>>;
  backupHealthy?: boolean;
  assertWriteChannel?: (args: {
    expectedChannelId?: string;
  }) => Promise<{ expectedChannelId: string; shouldPersistSelection: boolean; userId: string | null }>;
  /** AC-BACKUP-01 ordering proof: when supplied, `captureBackup` appends a "backup" entry
   * here. A test pairs this with its own instrumented executor appending a "write" entry,
   * to assert the real relative order across the createBatch/executeBatch call boundary --
   * not just that both happen somewhere in the pipeline. */
  calls?: Array<{ type: "backup" | "write"; videoId: string }>;
} = {}) {
  const store = createFakeStore();
  let counter = 0;
  const auditEvents: Array<{ ledgerRowId: string; eventType: string; detail: unknown }> = [];
  const freshCallCount: Record<string, number> = {};

  const services = createBatchServices({
    batchStore: store,
    changeSetStore: store,
    authResolver: {
      async resolve() {
        return { credentialRef: { userId: "user-1" }, accessToken: "tok", scopeSet: new Set<string>() };
      },
    },
    writeContext: {
      assertWriteChannel:
        options.assertWriteChannel ??
        (async (args) => ({ expectedChannelId: args.expectedChannelId ?? "UC_TEST", shouldPersistSelection: false, userId: "user-1" })),
    },
    youtubeApi: {
      async fetchFreshVideoContext(args: { videoId: string }) {
        const sequence = options.freshSequenceByVideoId?.[args.videoId];
        const callIndex = freshCallCount[args.videoId] ?? 0;
        freshCallCount[args.videoId] = callIndex + 1;
        if (sequence) return sequence[Math.min(callIndex, sequence.length - 1)];

        // Default dynamic behavior for tests that don't care about exact fetch
        // sequencing (isolation/quota/retry-count tests): the first TWO fetches for a
        // video (prepareBatchExecution's preparation-time check, then executeBatch's own
        // mandatory immediately-before-send re-check -- both happen before any attempt is
        // ever made) see each change's baseline value; every later fetch (post-write
        // verification, or a reconciliation read) sees the proposed value, as if the
        // write conceptually already applied. This is what lets those tests ignore
        // call-by-call fetch sequencing entirely, while tests that specifically exercise
        // §0.F's sequencing (AC-TIMEOUT-01, AC-VERIFY-*, AC-AUDIT-05) still use an
        // explicit freshSequenceByVideoId override.
        const relevantChanges = [...store.changes.values()].filter((c) => c.videoId === args.videoId);
        const localizations: Record<string, { title: string; description: string }> = {};
        for (const change of relevantChanges) {
          const value = callIndex < 2 ? change.baselineValue : change.proposedValue;
          const existing = localizations[change.language] ?? { title: "", description: "" };
          localizations[change.language] = { ...existing, [change.field]: value };
        }
        return { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations };
      },
    },
    backup: {
      async checkInfrastructureHealth() {
        return { healthy: options.backupHealthy ?? true };
      },
      async captureBackup(args: { videoId: string }) {
        options.calls?.push({ type: "backup", videoId: args.videoId });
        return { path: "/fake/backup.json", capturedAt: new Date().toISOString() };
      },
    },
    audit: {
      async record(input) {
        auditEvents.push({ ledgerRowId: input.ledgerRowId, eventType: input.eventType, detail: input.detail });
      },
    },
    clock: { async wait() {} }, // instant in tests -- no real backoff/reconciliation delay
    idGenerator: () => `id-${++counter}`,
    logger: { info() {}, error() {} },
  });

  return { store, services, auditEvents, freshCallCount };
}

async function createApprovedBatch(
  harness: ReturnType<typeof createHarness>,
  input: { channelId: string; dryRun?: boolean; selections: Array<{ videoId: string; changeIds: string[] }> },
  changeOverrides: Record<string, Partial<PendingChangeRecord>> = {}
) {
  for (const selection of input.selections) {
    for (const changeId of selection.changeIds) {
      harness.store.registerApprovedChange({ id: changeId, videoId: selection.videoId, ...changeOverrides[changeId] });
    }
  }
  return harness.services.createBatch(input);
}

/** What executeBatch's mandatory pre-send safety check (call #1 for any video) sees --
 * matches c1/c2/c3's default baseline ("") so the pre-send conflict check always passes
 * in tests that go on to exercise later reads (reconciliation/verification) explicitly. */
const PRE_SEND_BASELINE: Fixture = { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: {} };

function scriptedExecutor(results: WriteExecutorResult[]): WriteExecutor {
  let i = 0;
  return {
    async attemptWrite() {
      if (i >= results.length) throw new Error("executor script exhausted");
      return results[i++];
    },
  };
}

// Independent test-suite audit (2026-09-26): AC-BACKUP-01's own acceptance text requires
// proving backup precedes the write call for the SAME video. Every other test in this file
// exercises `createBatch` (captures the backup) and `executeBatch` (calls the executor) as two
// separate, sequentially-awaited top-level calls, which already structurally guarantees the
// order -- but nothing previously made that guarantee an explicit, checked assertion. This test
// closes that gap with a real (mocked) WriteExecutor, not the dry-run path (which never reaches
// a WriteExecutor at all), by recording both events into one shared, order-preserving array.
test("AC-BACKUP-01: backup is captured (during createBatch) before the write call (during executeBatch) for the same video, against a real mocked WriteExecutor", async () => {
  const calls: Array<{ type: "backup" | "write"; videoId: string }> = [];
  const harness = createHarness({ calls });

  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });

  const executor: WriteExecutor = {
    async attemptWrite() {
      calls.push({ type: "write", videoId: "v1" });
      return { outcome: "SUCCESS" };
    },
  };
  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.results[0].status, "SUCCESS");
  const backupIndex = calls.findIndex((c) => c.type === "backup" && c.videoId === "v1");
  const writeIndex = calls.findIndex((c) => c.type === "write" && c.videoId === "v1");
  assert.ok(backupIndex !== -1, "captureBackup must actually have been called for v1");
  assert.ok(writeIndex !== -1, "the executor must actually have been called for v1");
  assert.ok(backupIndex < writeIndex, "backup must be captured strictly before the write call for the same video");
});

test("§0.E: a transient FAILED is retried up to maxAttempts and succeeds", async () => {
  const harness = createHarness({
    freshSequenceByVideoId: {
      v1: [
        PRE_SEND_BASELINE, // prepareBatchExecution's preparation-time fetch
        PRE_SEND_BASELINE, // executeBatch's mandatory immediately-before-send re-check
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "New Value", description: "" } } }, // post-write verification
      ],
    },
  });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });

  const executor = scriptedExecutor([
    { outcome: "FAILED", detail: "503", classification: "transient" },
    { outcome: "FAILED", detail: "503", classification: "transient" },
    { outcome: "SUCCESS" },
  ]);

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.results[0].status, "SUCCESS");
  const attempts = await harness.services.listAttempts((await harness.services.listLedgerRows(batch.id))[0].id);
  assert.equal(attempts.length, 3);
});

test("§0.E: a permanent FAILED is never retried", async () => {
  const harness = createHarness();
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });
  const executor = scriptedExecutor([{ outcome: "FAILED", detail: "insufficient permissions", classification: "permanent" }]);

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.results[0].status, "FAILED");
  const attempts = await harness.services.listAttempts((await harness.services.listLedgerRows(batch.id))[0].id);
  assert.equal(attempts.length, 1);
});

test("§0.E: retries are exhausted after maxAttempts (4) even if every failure is transient", async () => {
  const harness = createHarness();
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });
  const executor = scriptedExecutor([
    { outcome: "FAILED", detail: "503", classification: "transient" },
    { outcome: "FAILED", detail: "503", classification: "transient" },
    { outcome: "FAILED", detail: "503", classification: "transient" },
    { outcome: "FAILED", detail: "503", classification: "transient" },
  ]);

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.results[0].status, "FAILED");
  const attempts = await harness.services.listAttempts((await harness.services.listLedgerRows(batch.id))[0].id);
  assert.equal(attempts.length, 4);
});

test("AC-TIMEOUT-01 sub-case 1: first reconciliation read matches requested -> SUCCESS, no retry", async () => {
  const harness = createHarness({
    freshSequenceByVideoId: {
      v1: [
        PRE_SEND_BASELINE, // prepareBatchExecution's preparation-time fetch
        PRE_SEND_BASELINE, // executeBatch's mandatory immediately-before-send re-check
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "New Value", description: "" } } }, // §0.F Step 1: matches proposed
      ],
    },
  });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });
  const executor = scriptedExecutor([{ outcome: "UNKNOWN", detail: "timeout" }]);

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.results[0].status, "SUCCESS");
  assert.equal(summary.results[0].ownResponseObserved, false);
  const attempts = await harness.services.listAttempts((await harness.services.listLedgerRows(batch.id))[0].id);
  assert.equal(attempts.length, 1); // no retry issued by reconciliation
});

test("AC-TIMEOUT-01 sub-case 2: two consistent negative reads -> UNKNOWN, never a retry", async () => {
  const harness = createHarness({
    freshSequenceByVideoId: {
      v1: [
        PRE_SEND_BASELINE, // prepareBatchExecution's preparation-time fetch
        PRE_SEND_BASELINE, // executeBatch's mandatory immediately-before-send re-check
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: {} }, // §0.F Step 1: baseline
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: {} }, // §0.F Step 2: still baseline
      ],
    },
  });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });
  const executor = scriptedExecutor([{ outcome: "UNKNOWN", detail: "timeout" }]);

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.results[0].status, "UNKNOWN");
  const attempts = await harness.services.listAttempts((await harness.services.listLedgerRows(batch.id))[0].id);
  assert.equal(attempts.length, 1); // procedure never issues a retry by itself
  const row = (await harness.services.listLedgerRows(batch.id))[0];
  assert.equal(row.status, "UNKNOWN");
});

test("AC-TIMEOUT-01 sub-case 3: stale first read, second read matches requested -> SUCCESS", async () => {
  const harness = createHarness({
    freshSequenceByVideoId: {
      v1: [
        PRE_SEND_BASELINE, // prepareBatchExecution's preparation-time fetch
        PRE_SEND_BASELINE, // executeBatch's mandatory immediately-before-send re-check
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: {} }, // §0.F Step 1: baseline (stale)
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "New Value", description: "" } } }, // §0.F Step 2: requested now visible
      ],
    },
  });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });
  const executor = scriptedExecutor([{ outcome: "UNKNOWN", detail: "timeout" }]);

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.results[0].status, "SUCCESS");
  const attempts = await harness.services.listAttempts((await harness.services.listLedgerRows(batch.id))[0].id);
  assert.equal(attempts.length, 1);
});

test("AC-TIMEOUT-01 sub-case 4: inconsistent/failed second read -> UNKNOWN", async () => {
  const harness = createHarness({
    freshSequenceByVideoId: {
      v1: [
        PRE_SEND_BASELINE, // prepareBatchExecution's preparation-time fetch
        PRE_SEND_BASELINE, // executeBatch's mandatory immediately-before-send re-check
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: {} }, // §0.F Step 1: baseline
        null, // §0.F Step 2: fetch fails / inconsistent
      ],
    },
  });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });
  const executor = scriptedExecutor([{ outcome: "UNKNOWN", detail: "timeout" }]);

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.results[0].status, "UNKNOWN");
});

test("AC-TIMEOUT-02 / §0.F Step 4: resolving UNKNOWN re-runs the full pipeline and detects a new conflict instead of blindly resending", async () => {
  const harness = createHarness({
    freshSequenceByVideoId: {
      v1: [
        PRE_SEND_BASELINE, // prepareBatchExecution's preparation-time fetch
        PRE_SEND_BASELINE, // executeBatch's mandatory immediately-before-send re-check
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: {} }, // attempt's §0.F Step 1: baseline
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: {} }, // attempt's §0.F Step 2: still baseline -> UNKNOWN
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "Someone Else's Edit", description: "" } } }, // resolveUnknownLedgerRow's own pre-send fetch
      ],
    },
  });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });
  const executor = scriptedExecutor([{ outcome: "UNKNOWN", detail: "timeout" }]);

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });
  assert.equal(summary.results[0].status, "UNKNOWN");

  const rowId = (await harness.services.listLedgerRows(batch.id))[0].id;
  const resolved = await harness.services.resolveUnknownLedgerRow({ ledgerRowId: rowId, credentialRef: { userId: "user-1" } });

  assert.equal(resolved.status, "CONFLICT");
  // No videos.update-equivalent call was ever made with the stale payload -- only 1
  // attempt total exists (the original UNKNOWN one), proving no blind resend occurred.
  const attempts = await harness.services.listAttempts(rowId);
  assert.equal(attempts.length, 1);
});

test("AC-VERIFY-01/AC-CONFLICT-02: a SUCCESS response with a verification mismatch is FAILED, never SUCCESS", async () => {
  const harness = createHarness({
    freshSequenceByVideoId: {
      v1: [
        PRE_SEND_BASELINE, // prepareBatchExecution's preparation-time fetch
        PRE_SEND_BASELINE, // executeBatch's mandatory immediately-before-send re-check
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "Someone Else's Edit", description: "" } } }, // post-write verification
      ],
    },
  });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });
  const executor = scriptedExecutor([{ outcome: "SUCCESS" }]);

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.results[0].status, "FAILED");
});

test("AC-VERIFY-02: a genuine SUCCESS stores requested/confirmed/timestamp via verificationResult", async () => {
  const harness = createHarness({
    freshSequenceByVideoId: {
      v1: [
        PRE_SEND_BASELINE, // prepareBatchExecution's preparation-time fetch
        PRE_SEND_BASELINE, // executeBatch's mandatory immediately-before-send re-check
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "New Value", description: "" } } }, // post-write verification
      ],
    },
  });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });
  const executor = scriptedExecutor([{ outcome: "SUCCESS" }]);

  await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  const row = (await harness.services.listLedgerRows(batch.id))[0];
  assert.equal(row.status, "SUCCESS");
  assert.ok(row.verificationResult);
  const verification = row.verificationResult as { ownResponseObserved: boolean; confirmedAt: string };
  assert.equal(verification.ownResponseObserved, true);
  assert.ok(verification.confirmedAt);
});

test("AC-AUDIT-05: reconciliation-confirmed SUCCESS records ownResponseObserved:false, ordinary SUCCESS records true", async () => {
  const harness = createHarness({
    freshSequenceByVideoId: {
      v1: [PRE_SEND_BASELINE, PRE_SEND_BASELINE, { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "New Value", description: "" } } }],
      v2: [PRE_SEND_BASELINE, PRE_SEND_BASELINE, { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "New Value", description: "" } } }],
    },
  });
  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    dryRun: false,
    selections: [
      { videoId: "v1", changeIds: ["c1"] },
      { videoId: "v2", changeIds: ["c2"] },
    ],
  });
  const executor = scriptedExecutor([{ outcome: "SUCCESS" }, { outcome: "UNKNOWN", detail: "timeout" }]);

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  const byVideo = Object.fromEntries(summary.results.map((r) => [r.videoId, r]));
  assert.equal(byVideo.v1.status, "SUCCESS");
  assert.equal(byVideo.v1.ownResponseObserved, true);
  assert.equal(byVideo.v2.status, "SUCCESS");
  assert.equal(byVideo.v2.ownResponseObserved, false);

  const resultEvents = harness.auditEvents.filter((e) => e.eventType === "VERIFICATION");
  const own = resultEvents.find((e) => (e.detail as { ownResponseObserved: boolean }).ownResponseObserved === true);
  const reconciled = resultEvents.find((e) => (e.detail as { ownResponseObserved: boolean }).ownResponseObserved === false);
  assert.ok(own);
  assert.ok(reconciled);
});

test("AC-ISOLATION-01: one video's FAILED does not stop the rest of the batch", async () => {
  const harness = createHarness();
  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    dryRun: false,
    selections: [
      { videoId: "v1", changeIds: ["c1"] },
      { videoId: "v2", changeIds: ["c2"] },
    ],
  });
  const executor = scriptedExecutor([
    { outcome: "FAILED", detail: "insufficient permissions", classification: "permanent" },
    { outcome: "SUCCESS" },
  ]);

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  const byVideo = Object.fromEntries(summary.results.map((r) => [r.videoId, r.status]));
  assert.equal(byVideo.v1, "FAILED");
  assert.equal(byVideo.v2, "SUCCESS");
});

test("AC-ISOLATION-02/quota: a systemic failure halts remaining rows without touching already-completed ones", async () => {
  const harness = createHarness();
  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    dryRun: false,
    selections: [
      { videoId: "v1", changeIds: ["c1"] },
      { videoId: "v2", changeIds: ["c2"] },
      { videoId: "v3", changeIds: ["c3"] },
    ],
  });
  const executor = scriptedExecutor([
    { outcome: "SUCCESS" }, // v1 completes normally
    { outcome: "FAILED", detail: "quota exhausted", classification: "permanent", systemic: true }, // v2 triggers systemic halt
  ]);

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.haltedSystemically, true);
  const byVideo = Object.fromEntries(summary.results.map((r) => [r.videoId, r.status]));
  assert.equal(byVideo.v1, "SUCCESS"); // untouched by the later systemic halt
  assert.equal(byVideo.v2, "FAILED");
  assert.equal(byVideo.v3, "ABORTED_SYSTEMIC"); // never attempted

  const finalBatch = await harness.services.getBatch(batch.id);
  assert.equal(finalBatch.status, "ABORTED");
});

test("AC-ISOLATION-03: the error report lists every non-successful item with detail", async () => {
  const harness = createHarness();
  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    dryRun: false,
    selections: [
      { videoId: "v1", changeIds: ["c1"] },
      { videoId: "v2", changeIds: ["c2"] },
    ],
  });
  const executor = scriptedExecutor([
    { outcome: "SUCCESS" },
    { outcome: "FAILED", detail: "insufficient permissions", classification: "permanent" },
  ]);

  await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  const report = await harness.services.getBatchErrorReport(batch.id);
  assert.equal(report.length, 1);
  assert.equal(report[0].videoId, "v2");
  assert.equal(report[0].status, "FAILED");
});

// (independent review, review series cycle 2): the reconciliation-detected CONFLICT path
// (finalizeConflict, called when the very first reconciliation read neither matches the
// requested nor the baseline value) is a fourth CONFLICT-producing code path, missed by
// cycle 1's fix to the other three -- it returned no conflictingChangeIds at all.
test("AC-TIMEOUT-01 (diverged variant): a first reconciliation read that matches neither requested nor baseline is CONFLICT, with conflictingChangeIds populated", async () => {
  const harness = createHarness({
    freshSequenceByVideoId: {
      v1: [
        PRE_SEND_BASELINE, // prepareBatchExecution's preparation-time fetch
        PRE_SEND_BASELINE, // executeBatch's mandatory immediately-before-send re-check
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "Changed In Studio", description: "" } } }, // §0.F Step 1: neither requested ("New Value") nor baseline ("")
      ],
    },
  });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });
  const executor = scriptedExecutor([{ outcome: "UNKNOWN", detail: "timeout" }]);

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.results[0].status, "CONFLICT");
  assert.deepEqual(summary.results[0].conflictingChangeIds, ["c1"]);
});

// (independent review, second cycle): executeBatch's own mandatory pre-send re-check (distinct
// from prepareBatchExecution's preparation-time check) is one of (now) four code paths that can
// produce a CONFLICT ExecutionResult -- this one previously omitted conflictingChangeIds from
// the returned result even though the identical audit record for the same event always
// included it, and the other paths (prepareLedgerRow, resolveUnknownLedgerRow) also include it.
test("a conflict detected by executeBatch's own pre-send re-check reports conflictingChangeIds in the result, not just the audit trail", async () => {
  const harness = createHarness({
    freshSequenceByVideoId: {
      v1: [
        PRE_SEND_BASELINE, // prepareBatchExecution's preparation-time fetch -- matches baseline
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "Changed In Studio", description: "" } } }, // executeBatch's own re-check -- diverged
      ],
    },
  });
  const batch = await createApprovedBatch(
    harness,
    { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] },
    { c1: { language: "es", field: "title", baselineValue: "" } }
  );

  const executor = scriptedExecutor([]); // must never be reached -- conflict blocks before send
  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.results[0].status, "CONFLICT");
  assert.deepEqual(summary.results[0].conflictingChangeIds, ["c1"]);
});

test("resolveUnknownLedgerRow rejects a row that is not UNKNOWN", async () => {
  const harness = createHarness();
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });
  const rowId = (await harness.services.listLedgerRows(batch.id))[0].id;

  await assert.rejects(
    () => harness.services.resolveUnknownLedgerRow({ ledgerRowId: rowId, credentialRef: { userId: "user-1" } }),
    (error: unknown) => error instanceof DomainError && error.code === "ledger_invalid_transition"
  );
});

// RISK-28 (docs/TECHNICAL_DEBT.md): executeBatch previously only re-checked the write-channel
// identity guardrail via prepareBatchExecution, which only runs when the batch is still
// PENDING. Resuming a batch already RUNNING (e.g. a new process picking it up after a crash)
// skipped that check entirely. This simulates exactly that: claimBatchExecution flips the
// batch straight to RUNNING without ever calling assertWriteChannel (as a prior process would
// have already done before crashing), then executeBatch is called against it -- the guardrail
// must still run and fail closed if the currently-active credentials resolve to a different
// channel than the batch expects.
test("AGENTS.md §G / RISK-28: resuming a RUNNING batch still enforces the write-channel guardrail", async () => {
  let assertWriteChannelCalls = 0;
  const harness = createHarness({
    assertWriteChannel: async (args) => {
      assertWriteChannelCalls++;
      if (args.expectedChannelId !== "UC_TEST") {
        throw new DomainError({
          code: "WRITE_CHANNEL_MISMATCH",
          message: "Active credentials do not match the batch's expected channel",
        });
      }
      return { expectedChannelId: args.expectedChannelId, shouldPersistSelection: false, userId: "user-1" };
    },
  });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });

  // Simulate "already RUNNING, resumed by a new process" without ever going through
  // prepareBatchExecution's own guardrail call.
  await harness.store.claimBatchExecution(batch.id, "prior-run");

  const executor = scriptedExecutor([]); // must never be reached
  await assert.rejects(
    () => harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, expectedChannelId: "UC_OTHER", executor }),
    (error: unknown) => error instanceof DomainError && error.code === "WRITE_CHANNEL_MISMATCH"
  );

  assert.equal(assertWriteChannelCalls, 1, "the guardrail must actually run on resume, not be silently skipped");
  const row = (await harness.services.listLedgerRows(batch.id))[0];
  assert.equal(row.status, "PENDING", "no row should have been touched before the guardrail check");
  const finalBatch = await harness.store.getBatch(batch.id);
  assert.equal(finalBatch?.status, "ABORTED");
});
