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
    batches,
    locks,
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
  verifyRetryDelaysMs?: number[];
  channelBaseline?: string | null;
  assertWriteChannel?: (args: {
    expectedChannelId?: string;
  }) => Promise<{ expectedChannelId: string; shouldPersistSelection: boolean; userId: string | null }>;
  /** AC-BACKUP-01 ordering proof: when supplied, `captureBackup` appends a "backup" entry
   * here. A test pairs this with its own instrumented executor appending a "write" entry,
   * to assert the real relative order across the createBatch/executeBatch call boundary --
   * not just that both happen somewhere in the pipeline. */
  calls?: Array<{ type: "backup" | "write"; videoId: string }>;
  /** Called from captureBackup (the preparation phase) with the video being prepared. */
  onBackup?: (videoId: string) => void;
  /** The device-availability gate, checked before every not-yet-started row (RISK-94). */
  assertMutationAllowed?: () => Promise<void>;
  /** BL-117 slice 2: the pre-flight quota guard and the atomic split, both optional like in production wiring tests. */
  quotaGuard?: Parameters<typeof createBatchServices>[0]["quotaGuard"];
  splitPendingBatch?: Parameters<typeof createBatchServices>[0]["splitPendingBatch"];
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
    channelLanguageBaseline: options.channelBaseline === undefined ? undefined : { getExpectedDefaultLanguage: async () => options.channelBaseline ?? null },
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
        options.onBackup?.(args.videoId);
        return { path: "/fake/backup.json", capturedAt: new Date().toISOString() };
      },
    },
    audit: {
      async record(input) {
        auditEvents.push({ ledgerRowId: input.ledgerRowId, eventType: input.eventType, detail: input.detail });
      },
    },
    clock: { async wait() {} }, // instant in tests -- no real backoff/reconciliation delay
    verifyRetryDelaysMs: options.verifyRetryDelaysMs,
    assertMutationAllowed: options.assertMutationAllowed,
    quotaGuard: options.quotaGuard,
    splitPendingBatch: options.splitPendingBatch,
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

test("verification: a first post-write read that still shows the baseline (stale) is re-read, and a later fresh read confirms SUCCESS", async () => {
  const harness = createHarness({
    verifyRetryDelaysMs: [0, 0],
    freshSequenceByVideoId: {
      v1: [
        PRE_SEND_BASELINE,
        PRE_SEND_BASELINE,
        PRE_SEND_BASELINE, // first post-write read: stale, still the baseline
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "New Value", description: "" } } },
      ],
    },
  });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor: scriptedExecutor([{ outcome: "SUCCESS" }]) });

  assert.equal(summary.results[0].status, "SUCCESS");
  assert.equal(harness.freshCallCount["v1"], 4);
});

test("verification: a read that stays at the baseline after every retry is FAILED, and the audit event says what was observed (lengths/booleans only)", async () => {
  const harness = createHarness({ verifyRetryDelaysMs: [0, 0], freshSequenceByVideoId: { v1: [PRE_SEND_BASELINE] } });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor: scriptedExecutor([{ outcome: "SUCCESS" }]) });

  assert.equal(summary.results[0].status, "FAILED");
  assert.equal(harness.freshCallCount["v1"], 5); // 2 pre-write + 1 verification + 2 retries
  const event = harness.auditEvents.find((e) => e.eventType === "VERIFICATION") as { detail: { classification: string; observed: Array<Record<string, unknown>> } };
  assert.equal(event.detail.classification, "matches_baseline");
  assert.equal(event.detail.observed[0].equalsRequested, false);
  assert.equal(event.detail.observed[0].equalsBaseline, true);
  assert.equal("observedValue" in event.detail.observed[0], false);
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

// Architecture audit 2026-10-01 (H1, docs/roadmap/plans/HARDENING_AUDIT_2026-10_PLAN.md AC-H1-3): the
// Live-writes gate refusing an attempt (it runs before anything is sent) must end the row as a clean
// FAILED with its lock released -- never a stranded APPLYING row (which is an unresolved execution
// and would put the device into recovery mode) -- and halt the rest of the batch systemically.
test("AC-H1-3: an attempt refused by the Live-writes gate ends FAILED (not APPLYING), releases its lock, and halts the batch", async () => {
  const harness = createHarness();
  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    dryRun: false,
    selections: [
      { videoId: "v1", changeIds: ["c1"] },
      { videoId: "v2", changeIds: ["c2"] },
    ],
  });
  const executor: WriteExecutor = {
    async attemptWrite() {
      throw new DomainError({ code: "live_writes_disabled", message: "off" });
    },
  };

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.haltedSystemically, true);
  const rows = await harness.services.listLedgerRows(batch.id);
  assert.equal(rows.some((r) => r.status === "APPLYING"), false, "no row may be left APPLYING");
  const statuses = rows.map((r) => r.status).sort();
  assert.ok(statuses.includes("FAILED"));
  const attemptsOfFailed = await harness.services.listAttempts(rows.find((r) => r.status === "FAILED")!.id);
  assert.equal(attemptsOfFailed.at(-1)?.outcome, "FAILED");
  // The failed row's video lock is free again: another batch can take it.
  const failedVideo = rows.find((r) => r.status === "FAILED")!.videoId;
  assert.equal(
    await harness.store.acquireVideoExecutionLock({ videoId: failedVideo, batchId: "other-batch", ledgerRowId: "other-row" }),
    true
  );
});

// Owner authorization 2026-10-02: the channel baseline is injected as defaultLanguage for a video
// that has none, and the post-write read-back must confirm it (an unconfirmed language is FAILED).
const NO_DEFAULT_BASELINE = { snippet: { title: "T", description: "D", defaultLanguage: null }, localizations: {} };

test("channel baseline (live): injected defaultLanguage is sent and a read-back showing it -> SUCCESS; ATTEMPT audit records it", async () => {
  const harness = createHarness({
    channelBaseline: "en",
    freshSequenceByVideoId: {
      v1: [
        NO_DEFAULT_BASELINE,
        NO_DEFAULT_BASELINE,
        { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "New Value", description: "" } } },
      ],
    },
  });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });
  const sent: Array<Record<string, unknown>> = [];
  const executor = { async attemptWrite(payload: { snippet: Record<string, unknown> }) { sent.push(payload.snippet); return { outcome: "SUCCESS" as const }; } };

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor: executor as never });

  assert.equal(summary.results[0].status, "SUCCESS");
  assert.equal(sent[0].defaultLanguage, "en");
  const attempt = harness.auditEvents.find((e) => e.eventType === "ATTEMPT");
  assert.equal((attempt?.detail as { defaultLanguageApplied?: string }).defaultLanguageApplied, "en");
});

test("channel baseline (live): translations land but the read-back still has no defaultLanguage -> FAILED, never SUCCESS", async () => {
  const harness = createHarness({
    channelBaseline: "en",
    freshSequenceByVideoId: {
      v1: [
        NO_DEFAULT_BASELINE,
        NO_DEFAULT_BASELINE,
        { snippet: { title: "T", description: "D", defaultLanguage: null }, localizations: { es: { title: "New Value", description: "" } } },
      ],
    },
  });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: false, selections: [{ videoId: "v1", changeIds: ["c1"] }] });

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor: scriptedExecutor([{ outcome: "SUCCESS" }]) });

  assert.equal(summary.results[0].status, "FAILED");
});


// ---------------------------------------------------------------------------
// Batch Cancel (owner decision 2026-10-03: cancelled rows get the new terminal ledger status
// CANCELLED; the batch ends ABORTED). Acceptance criteria, fixed from the requirement before any
// implementation -- "stop BEFORE the next item, never interrupt a write already in flight":
//
// AC-CANCEL-01 a cancel requested while row 1 is being written lets row 1 finish and be verified
//   (SUCCESS); every row not yet started becomes CANCELLED; no further write is attempted.
// AC-CANCEL-02 a cancelled row holds no video lock afterwards.
// AC-CANCEL-03 every cancelled row gets a CANCELLED audit event; a completed row does not.
// AC-CANCEL-04 a cancel during the PREPARATION phase means no write is ever sent: nothing is
//   written, rows end CANCELLED, the batch ends ABORTED.
// AC-CANCEL-05 a cancel for a batch that is not being executed is refused (accepted:false) and
//   leaves no stale flag: a later execution of the same batch is not affected by it.
// AC-CANCEL-06 a cancel after completion is refused and changes nothing.
// AC-CANCEL-07 a repeated cancel is harmless.
// AC-CANCEL-08 rows already terminal (FAILED) are never rewritten to CANCELLED.
// AC-CANCEL-09 with concurrency > 1 every in-flight write completes; every other row is CANCELLED;
//   the number of writes sent equals the number of SUCCESS rows; nothing stays APPLYING.
// AC-CANCEL-10 the state machine allows only PENDING and AWAITING_EXECUTION to become CANCELLED.
// RISK-94 gate: a refusal from the device-availability gate before a not-yet-started row halts the
//   batch systemically (ABORTED_SYSTEMIC for the rest) and no further write is sent.
// ---------------------------------------------------------------------------

import { ALLOWED_LEDGER_TRANSITIONS, TERMINAL_LEDGER_STATUSES } from "./contracts";

function threeVideoBatch(harness: ReturnType<typeof createHarness>, extra: { concurrency?: number } = {}) {
  return createApprovedBatch(harness, {
    channelId: "UC_TEST",
    dryRun: false,
    ...extra,
    selections: [
      { videoId: "v1", changeIds: ["c1"] },
      { videoId: "v2", changeIds: ["c2"] },
      { videoId: "v3", changeIds: ["c3"] },
    ],
  } as Parameters<typeof createApprovedBatch>[1]);
}

const statusOf = (harness: ReturnType<typeof createHarness>, videoId: string) =>
  [...harness.store.ledgerRows.values()].find((r) => r.videoId === videoId)!.status;

test("AC-CANCEL-01/02/03: cancel during row 1's write -> row 1 SUCCESS, rows 2-3 CANCELLED, one write, no locks, CANCELLED audit events, batch ABORTED", async () => {
  const harness = createHarness();
  const batch = await threeVideoBatch(harness);
  let writes = 0;
  const executor: WriteExecutor = {
    async attemptWrite() {
      writes += 1;
      // The operator presses Cancel while this (the first) write is in flight.
      const cancel = await harness.services.requestBatchCancel(batch.id);
      assert.equal(cancel.accepted, true);
      return { outcome: "SUCCESS" };
    },
  };

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(writes, 1);
  assert.equal(statusOf(harness, "v1"), "SUCCESS");
  assert.equal(statusOf(harness, "v2"), "CANCELLED");
  assert.equal(statusOf(harness, "v3"), "CANCELLED");
  assert.equal(summary.cancelled, true);
  assert.equal(summary.haltedSystemically, false);
  assert.equal((await harness.services.getBatch(batch.id)).status, "ABORTED");

  for (const videoId of ["v1", "v2", "v3"]) {
    assert.equal(await harness.store.getVideoExecutionLockHolder(videoId), null, `${videoId} must hold no lock`);
  }
  const cancelledAudit = harness.auditEvents.filter((e) => e.eventType === "CANCELLED").map((e) => e.ledgerRowId);
  const rowIdOf = (videoId: string) => [...harness.store.ledgerRows.values()].find((r) => r.videoId === videoId)!.id;
  assert.deepEqual(cancelledAudit.sort(), [rowIdOf("v2"), rowIdOf("v3")].sort());
});

test("AC-CANCEL-04: cancel during preparation -> no write is ever sent, rows end CANCELLED, batch ABORTED", async () => {
  let armed = false;
  let batchIdForCancel = "";
  const harness = createHarness({
    onBackup: () => {
      if (!armed) return;
      armed = false; // the operator presses Cancel while the FIRST row is being prepared
      void harness.services.requestBatchCancel(batchIdForCancel);
    },
  });
  const batch = await threeVideoBatch(harness);
  batchIdForCancel = batch.id;
  armed = true; // arm only for execution: createBatch may also capture backups
  let writes = 0;
  const executor: WriteExecutor = {
    async attemptWrite() {
      writes += 1;
      return { outcome: "SUCCESS" };
    },
  };

  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(writes, 0, "no write may be sent after a cancel during preparation");
  for (const videoId of ["v1", "v2", "v3"]) assert.equal(statusOf(harness, videoId), "CANCELLED");
  assert.equal(summary.cancelled, true);
  assert.equal((await harness.services.getBatch(batch.id)).status, "ABORTED");
  for (const videoId of ["v1", "v2", "v3"]) assert.equal(await harness.store.getVideoExecutionLockHolder(videoId), null);
});

test("AC-CANCEL-05: cancel for a batch that is not being executed is refused and leaves no stale flag", async () => {
  const harness = createHarness();
  const batch = await threeVideoBatch(harness);

  const refused = await harness.services.requestBatchCancel(batch.id);
  assert.equal(refused.accepted, false);

  let writes = 0;
  const executor: WriteExecutor = {
    async attemptWrite() {
      writes += 1;
      return { outcome: "SUCCESS" };
    },
  };
  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });
  assert.equal(writes, 3);
  assert.equal(summary.cancelled, false);
  for (const videoId of ["v1", "v2", "v3"]) assert.equal(statusOf(harness, videoId), "SUCCESS");
  assert.equal((await harness.services.getBatch(batch.id)).status, "COMPLETED");
});

test("AC-CANCEL-06: cancel after the batch completed is refused and changes nothing", async () => {
  const harness = createHarness();
  const batch = await threeVideoBatch(harness);
  await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor: scriptedExecutor([{ outcome: "SUCCESS" }, { outcome: "SUCCESS" }, { outcome: "SUCCESS" }]) });

  assert.equal((await harness.services.requestBatchCancel(batch.id)).accepted, false);
  for (const videoId of ["v1", "v2", "v3"]) assert.equal(statusOf(harness, videoId), "SUCCESS");
  assert.equal((await harness.services.getBatch(batch.id)).status, "COMPLETED");
});

test("AC-CANCEL-07: a repeated cancel while executing is harmless", async () => {
  const harness = createHarness();
  const batch = await threeVideoBatch(harness);
  const executor: WriteExecutor = {
    async attemptWrite() {
      await harness.services.requestBatchCancel(batch.id);
      const again = await harness.services.requestBatchCancel(batch.id);
      assert.equal(again.accepted, true);
      return { outcome: "SUCCESS" };
    },
  };
  await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });
  assert.equal(statusOf(harness, "v1"), "SUCCESS");
  assert.equal(statusOf(harness, "v2"), "CANCELLED");
  assert.equal(statusOf(harness, "v3"), "CANCELLED");
});

test("AC-CANCEL-08: a row that already ended FAILED stays FAILED when the batch is cancelled afterwards", async () => {
  const harness = createHarness();
  const batch = await threeVideoBatch(harness);
  let call = 0;
  const executor: WriteExecutor = {
    async attemptWrite() {
      call += 1;
      if (call === 1) return { outcome: "FAILED", detail: "insufficient permissions", classification: "permanent" };
      await harness.services.requestBatchCancel(batch.id);
      return { outcome: "SUCCESS" };
    },
  };
  await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });
  assert.equal(statusOf(harness, "v1"), "FAILED");
  assert.equal(statusOf(harness, "v2"), "SUCCESS");
  assert.equal(statusOf(harness, "v3"), "CANCELLED");
});

test("AC-CANCEL-09: with concurrency 2 every in-flight write completes, the rest are CANCELLED, writes == SUCCESS rows, nothing stays APPLYING", async () => {
  const harness = createHarness();
  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    dryRun: false,
    concurrency: 2,
    selections: [
      { videoId: "v1", changeIds: ["c1"] },
      { videoId: "v2", changeIds: ["c2"] },
      { videoId: "v3", changeIds: ["c3"] },
      { videoId: "v4", changeIds: ["c4"] },
      { videoId: "v5", changeIds: ["c5"] },
    ],
  } as Parameters<typeof createApprovedBatch>[1]);
  let writes = 0;
  const executor: WriteExecutor = {
    async attemptWrite() {
      writes += 1;
      await harness.services.requestBatchCancel(batch.id);
      return { outcome: "SUCCESS" };
    },
  };
  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  const statuses = [...harness.store.ledgerRows.values()].map((r) => r.status);
  assert.ok(statuses.every((st) => st === "SUCCESS" || st === "CANCELLED"), `unexpected statuses: ${statuses.join(",")}`);
  assert.equal(statuses.filter((st) => st === "SUCCESS").length, writes);
  assert.ok(statuses.includes("CANCELLED"));
  assert.equal(summary.cancelled, true);
  assert.equal((await harness.services.getBatch(batch.id)).status, "ABORTED");
  for (const videoId of ["v1", "v2", "v3", "v4", "v5"]) assert.equal(await harness.store.getVideoExecutionLockHolder(videoId), null);
});

test("AC-CANCEL-10: only PENDING and AWAITING_EXECUTION may become CANCELLED, and CANCELLED is terminal with no exits", () => {
  const sources = (Object.keys(ALLOWED_LEDGER_TRANSITIONS) as LedgerStatus[]).filter((from) => ALLOWED_LEDGER_TRANSITIONS[from].includes("CANCELLED"));
  assert.deepEqual(sources.sort(), ["AWAITING_EXECUTION", "PENDING"]);
  assert.deepEqual(ALLOWED_LEDGER_TRANSITIONS.CANCELLED, []);
  assert.equal(TERMINAL_LEDGER_STATUSES.has("CANCELLED"), true);
});

// The gate is consulted in BOTH phases (preparation also writes local state: ledger rows, locks,
// backups). For three rows that is calls 1-3 during preparation, then one call per row during
// execution (calls 4, 5, 6). The requirement is the same in both phases: a refusal stops every
// further step and no write is sent after it.
test("RISK-94 (execution phase): a refusal before the second row halts the rest and sends no more writes", async () => {
  let gateCalls = 0;
  const harness = createHarness({
    assertMutationAllowed: async () => {
      gateCalls += 1;
      if (gateCalls === 5) throw new Error("An export is running"); // preparation: 1-3, execution: v1 = 4, v2 = 5
    },
  });
  const batch = await threeVideoBatch(harness);
  let writes = 0;
  const executor: WriteExecutor = {
    async attemptWrite() {
      writes += 1;
      return { outcome: "SUCCESS" };
    },
  };
  const summary = await harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(writes, 1);
  assert.equal(statusOf(harness, "v1"), "SUCCESS");
  assert.equal(statusOf(harness, "v2"), "ABORTED_SYSTEMIC");
  assert.equal(statusOf(harness, "v3"), "ABORTED_SYSTEMIC");
  assert.equal(summary.haltedSystemically, true);
  assert.equal((await harness.services.getBatch(batch.id)).status, "ABORTED");
  // A terminal row must never hold a video lock (recoverLedgerRow's own design rule); a stranded lock
  // would make every later batch for that video fail with video_locked, with no UI way to clear it.
  for (const videoId of ["v1", "v2", "v3"]) {
    assert.equal(await harness.store.getVideoExecutionLockHolder(videoId), null, `${videoId} must hold no lock after a halted batch`);
  }
});

test("RISK-94 (preparation phase): a refusal while preparing aborts every unfinished row, releases the locks, sends no write and reports device_unavailable", async () => {
  let gateCalls = 0;
  const harness = createHarness({
    assertMutationAllowed: async () => {
      gateCalls += 1;
      if (gateCalls === 2) throw new Error("An import is running");
    },
  });
  const batch = await threeVideoBatch(harness);
  let writes = 0;
  const executor: WriteExecutor = {
    async attemptWrite() {
      writes += 1;
      return { outcome: "SUCCESS" };
    },
  };

  await assert.rejects(
    () => harness.services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor }),
    (error: unknown) => error instanceof DomainError && error.code === "device_unavailable"
  );

  assert.equal(writes, 0);
  for (const videoId of ["v1", "v2", "v3"]) {
    assert.equal(statusOf(harness, videoId), "ABORTED_SYSTEMIC");
    assert.equal(await harness.store.getVideoExecutionLockHolder(videoId), null);
  }
  assert.equal((await harness.services.getBatch(batch.id)).status, "ABORTED");
});


// Per-video exclusivity (AC-CONCURRENCY): a cancel races a worker that already moved the row on. If the
// guarded transition to CANCELLED did not happen because the row is already APPLYING, its lock must stay.
test("AC-CANCEL-11: a cancel that loses the race to a row already APPLYING neither rewrites it nor releases its lock", async () => {
  const harness = createHarness();
  const batch = await threeVideoBatch(harness);
  // Prepare only (rows AWAITING_EXECUTION, locks held), then move v1 to APPLYING as a concurrent worker would.
  await harness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } });
  const v1 = [...harness.store.ledgerRows.values()].find((r) => r.videoId === "v1")!;
  await harness.store.transitionLedgerRowStatus({ ledgerRowId: v1.id, from: ["AWAITING_EXECUTION"], to: "APPLYING" });
  assert.notEqual(await harness.store.getVideoExecutionLockHolder("v1"), null);

  // The cancel helper sees a stale in-memory snapshot (AWAITING_EXECUTION) of the row.
  const cancelled = await harness.services.cancelNotStartedRowForTest(batch.id, { ...v1, status: "AWAITING_EXECUTION" });

  assert.equal(cancelled, false);
  assert.equal(statusOf(harness, "v1"), "APPLYING", "an in-flight row is never rewritten");
  assert.notEqual(await harness.store.getVideoExecutionLockHolder("v1"), null, "its lock must stay while the write is in flight");
});

// ---------------------------------------------------------------------------
// BL-117 slice 2 -- pre-flight quota guard (docs/roadmap/plans/QUOTA_HISTORY_AND_GUARD_PLAN.md). Acceptance criteria written
// from the owner's requirement before the code: a live batch that certainly needs more quota than is left is refused BEFORE
// anything happens (no claim, no backup, no lock, no API call), the refusal says how many videos would fit and whether the
// batch can be split, an unreadable quota is its own refusal that the user may knowingly override, dry runs are never checked,
// a resumed batch counts only the rows still to write. No real YouTube write is involved (fake executor).
// ---------------------------------------------------------------------------

type GuardVerdictFake = NonNullable<Parameters<typeof createBatchServices>[0]["quotaGuard"]> extends { checkWriteRun(n: number): Promise<infer V> } ? V : never;

function guardReturning(verdict: GuardVerdictFake) {
  const asked: number[] = [];
  return {
    asked,
    guard: {
      async checkWriteRun(videos: number) {
        asked.push(videos);
        return verdict;
      },
    },
  };
}

function countingExecutor() {
  const state = { writes: 0 };
  const executor: WriteExecutor = {
    async attemptWrite() {
      state.writes += 1;
      return { outcome: "SUCCESS" };
    },
  };
  return { state, executor };
}

const EXEC_INPUT = { credentialRef: { userId: "user-1" }, expectedChannelId: "UC_TEST" };

test("BL-117 AC-G3: insufficient quota refuses the batch BEFORE anything starts: quota_insufficient with the numbers, batch still PENDING, no backup, no write, no lock", async () => {
  const { guard, asked } = guardReturning({ decision: "insufficient", estimatedUnits: 156, remainingUnits: 120, fitVideos: 2, resetsAt: "2026-10-04T07:00:00.000Z" });
  const backups: string[] = [];
  const harness = createHarness({ quotaGuard: guard, onBackup: (v) => backups.push(v) });
  const batch = await threeVideoBatch(harness);
  const { state, executor } = countingExecutor();

  await assert.rejects(
    harness.services.executeBatch({ batchId: batch.id, ...EXEC_INPUT, executor }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "quota_insufficient");
      assert.deepEqual(error.details, {
        batchId: batch.id,
        estimatedUnits: 156,
        remainingUnits: 120,
        rowsToWrite: 3,
        fitVideos: 2,
        resetsAt: "2026-10-04T07:00:00.000Z",
        canSplit: true,
      });
      return true;
    }
  );

  assert.deepEqual(asked, [3]);
  assert.equal(state.writes, 0);
  assert.equal((await harness.services.getBatch(batch.id)).status, "PENDING");
  assert.deepEqual(backups, [], "no backup was taken");
  assert.equal(harness.store.locks.size, 0);
  assert.equal(Object.keys(harness.freshCallCount).length, 0, "no API read was made");
  assert.ok([...harness.store.ledgerRows.values()].every((r) => r.status === "PENDING"));
});

test("BL-117: when not even one video fits, the refusal says it cannot be split", async () => {
  const { guard } = guardReturning({ decision: "insufficient", estimatedUnits: 156, remainingUnits: 30, fitVideos: 0, resetsAt: null });
  const harness = createHarness({ quotaGuard: guard });
  const batch = await threeVideoBatch(harness);
  await assert.rejects(
    harness.services.executeBatch({ batchId: batch.id, ...EXEC_INPUT, executor: countingExecutor().executor }),
    (error: unknown) => error instanceof DomainError && error.code === "quota_insufficient" && (error.details as { canSplit: boolean }).canSplit === false
  );
});

test("BL-117 AC-G2: an allowed verdict lets the batch run normally (all three videos written)", async () => {
  const { guard } = guardReturning({ decision: "allow", estimatedUnits: 156, remainingUnits: 156, fitVideos: 3 });
  const harness = createHarness({ quotaGuard: guard });
  const batch = await threeVideoBatch(harness);
  const { state, executor } = countingExecutor();
  const summary = await harness.services.executeBatch({ batchId: batch.id, ...EXEC_INPUT, executor });
  assert.equal(state.writes, 3);
  assert.equal(summary.results.length, 3);
});

test("BL-117 AC-G4: an unreadable quota refuses with quota_unknown (Cloud-connected flag told), unless the user acknowledges", async () => {
  const { guard } = guardReturning({ decision: "unknown", estimatedUnits: 156, cloudConnected: false });
  const harness = createHarness({ quotaGuard: guard });
  const batch = await threeVideoBatch(harness);
  const first = countingExecutor();
  await assert.rejects(
    harness.services.executeBatch({ batchId: batch.id, ...EXEC_INPUT, executor: first.executor }),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "quota_unknown" &&
      (error.details as { cloudConnected: boolean; estimatedUnits: number }).cloudConnected === false &&
      (error.details as { estimatedUnits: number }).estimatedUnits === 156
  );
  assert.equal(first.state.writes, 0);
  assert.equal((await harness.services.getBatch(batch.id)).status, "PENDING");

  const second = countingExecutor();
  await harness.services.executeBatch({ batchId: batch.id, ...EXEC_INPUT, executor: second.executor, acknowledgeUnknownQuota: true });
  assert.equal(second.state.writes, 3, "knowingly overriding runs the batch");
});

test("BL-117 AC-G5: a dry-run batch costs no quota and is never checked", async () => {
  const { guard, asked } = guardReturning({ decision: "insufficient", estimatedUnits: 1, remainingUnits: 0, fitVideos: 0, resetsAt: null });
  const harness = createHarness({ quotaGuard: guard });
  const batch = await createApprovedBatch(harness, { channelId: "UC_TEST", dryRun: true, selections: [{ videoId: "v1", changeIds: ["c1"] }] });
  await harness.services.executeBatch({ batchId: batch.id, ...EXEC_INPUT, executor: countingExecutor().executor });
  assert.deepEqual(asked, []);
});

test("BL-117 AC-G6: a resumed (RUNNING) batch counts only the rows still to write and is never splittable", async () => {
  const { guard, asked } = guardReturning({ decision: "insufficient", estimatedUnits: 104, remainingUnits: 60, fitVideos: 1, resetsAt: null });
  const harness = createHarness({ quotaGuard: guard });
  const batch = await threeVideoBatch(harness);
  const stored = harness.store.batches.get(batch.id)!;
  stored.status = "RUNNING";
  const rows = [...harness.store.ledgerRows.values()];
  rows[0].status = "SUCCESS"; // already written
  await assert.rejects(
    harness.services.executeBatch({ batchId: batch.id, ...EXEC_INPUT, executor: countingExecutor().executor }),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "quota_insufficient" &&
      (error.details as { rowsToWrite: number; canSplit: boolean }).rowsToWrite === 2 &&
      (error.details as { canSplit: boolean }).canSplit === false
  );
  assert.deepEqual(asked, [2]);
});

test("BL-117: a batch with nothing left to write is not checked at all", async () => {
  const { guard, asked } = guardReturning({ decision: "insufficient", estimatedUnits: 52, remainingUnits: 0, fitVideos: 0, resetsAt: null });
  const harness = createHarness({ quotaGuard: guard });
  const batch = await threeVideoBatch(harness);
  harness.store.batches.get(batch.id)!.status = "RUNNING";
  for (const row of harness.store.ledgerRows.values()) row.status = "SUCCESS";
  await harness.services.executeBatch({ batchId: batch.id, ...EXEC_INPUT, executor: countingExecutor().executor });
  assert.deepEqual(asked, []);
});

test("BL-117 AC-G7/G8: splitBatchForQuota asks the atomic split for exactly the fitting number of videos and returns both new batch ids", async () => {
  const { guard } = guardReturning({ decision: "insufficient", estimatedUnits: 156, remainingUnits: 110, fitVideos: 2, resetsAt: null });
  const splitCalls: Array<{ batchId: string; fitCount: number; fitsBatchId: string | null; restBatchId: string | null }> = [];
  const harness = createHarness({
    quotaGuard: guard,
    splitPendingBatch: async (input) => {
      splitCalls.push({ batchId: input.batchId, fitCount: input.fitCount, fitsBatchId: input.fitsBatchId, restBatchId: input.restBatchId });
      return { fitsBatchId: input.fitsBatchId, restBatchId: input.restBatchId, fitRows: input.fitCount, restRows: 3 - input.fitCount };
    },
  });
  const batch = await threeVideoBatch(harness);
  const result = await harness.services.splitBatchForQuota({ batchId: batch.id });
  assert.equal(splitCalls.length, 1);
  assert.equal(splitCalls[0].batchId, batch.id);
  assert.equal(splitCalls[0].fitCount, 2);
  assert.ok(splitCalls[0].fitsBatchId && splitCalls[0].restBatchId && splitCalls[0].fitsBatchId !== splitCalls[0].restBatchId);
  assert.deepEqual(
    { fitRows: result.fitRows, restRows: result.restRows, estimatedUnits: result.estimatedUnits, remainingUnits: result.remainingUnits },
    { fitRows: 2, restRows: 1, estimatedUnits: 156, remainingUnits: 110 }
  );
});

test("BL-117: splitBatchForQuota refuses when the batch fits (nothing to split), the quota is unknown, nothing fits, or the batch is not a fresh live batch", async () => {
  const make = async (verdict: GuardVerdictFake, mutate?: (h: ReturnType<typeof createHarness>, batchId: string) => void) => {
    const { guard } = guardReturning(verdict);
    let splitCalled = false;
    const harness = createHarness({ quotaGuard: guard, splitPendingBatch: async () => ((splitCalled = true), null) });
    const batch = await threeVideoBatch(harness);
    mutate?.(harness, batch.id);
    const error = await harness.services.splitBatchForQuota({ batchId: batch.id }).then(() => null, (e: unknown) => e);
    return { error, splitCalled };
  };

  const fits = await make({ decision: "allow", estimatedUnits: 156, remainingUnits: 500, fitVideos: 9 });
  assert.ok(fits.error instanceof DomainError && fits.error.code === "validation_failed");
  assert.equal(fits.splitCalled, false);

  const unknown = await make({ decision: "unknown", estimatedUnits: 156, cloudConnected: false });
  assert.ok(unknown.error instanceof DomainError && unknown.error.code === "quota_unknown");

  const none = await make({ decision: "insufficient", estimatedUnits: 156, remainingUnits: 10, fitVideos: 0, resetsAt: null });
  assert.ok(none.error instanceof DomainError && none.error.code === "quota_insufficient");
  assert.equal(none.splitCalled, false);

  const started = await make({ decision: "insufficient", estimatedUnits: 156, remainingUnits: 110, fitVideos: 2, resetsAt: null }, (h, id) => {
    h.store.batches.get(id)!.status = "RUNNING";
  });
  assert.ok(started.error instanceof DomainError && started.error.code === "validation_failed");
  assert.equal(started.splitCalled, false);
});

test("BL-117: if the atomic split reports the batch is no longer splittable (it was started meanwhile), nothing is reported as split", async () => {
  const { guard } = guardReturning({ decision: "insufficient", estimatedUnits: 156, remainingUnits: 110, fitVideos: 2, resetsAt: null });
  const harness = createHarness({ quotaGuard: guard, splitPendingBatch: async () => null });
  const batch = await threeVideoBatch(harness);
  await assert.rejects(
    harness.services.splitBatchForQuota({ batchId: batch.id }),
    (error: unknown) => error instanceof DomainError && error.code === "batch_already_running"
  );
});
