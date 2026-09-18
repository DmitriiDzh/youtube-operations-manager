// ---------------------------------------------------------------------------
// Acceptance matrix (Step 1-2, docs/DEVELOPMENT_PLAYBOOK.md §6.14), fixed from
// docs/acceptance/PHASE_5_ACCEPTANCE.md before writing prepareBatchExecution:
//
// AC-GUARD-01 (= official test §55): wrong-channel guardrail rejects the WHOLE batch
//   before any write/backup for any video. Zero videos.update calls, zero backups.
//
// AC-DRYRUN-01/02: a dry-run batch runs identity check, fresh fetch, merge/diff, backup
//   -- everything except an actual write -- and each row lands on DRY_RUN_COMPLETE, never
//   SUCCESS. Omitting `dryRun` must behave identically to passing `true` (fail-safe
//   default) -- already covered at the schema level in schemas.ts/createBatch; this file
//   additionally proves the *pipeline*, given a dry-run batch, never touches a
//   WriteExecutor (there isn't one wired at all in this module yet -- see index.ts).
//
// AC-BATCH-03 (send-time re-check): a change edited/revoked/invalidated after batch
//   creation blocks that video's write with FAILED, not CONFLICT -- the frozen batch
//   membership does not license publishing a payload built from an invalid approval.
//
// AC-CONFLICT-01 / AC-LEDGER-04 (service level): a baseline that no longer matches the
// FRESH fetch blocks with CONFLICT, verified through prepareBatchExecution end-to-end,
// not just merge.ts's pure function (see merge.test.ts for the pure-logic-level test).
//
// AC-MERGE-02 (RISK-03): the payload is built from the adapter's fetchFreshVideoContext
// result, never from fetchPreliminaryBatchContext's (deliberately different) result --
// proven by making the two mocks disagree and asserting which one wins.
//
// AC-BACKUP-04 (service level): backup infrastructure down halts the WHOLE batch before
// any per-video work, distinct from a single item's backup failing.
//
// AC-ISOLATION (minimal, Slice 2 scope only): one video's FAILED/CONFLICT does not stop
// the rest of the batch from being prepared.
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

function createFakeStore() {
  const batches = new Map<string, StoredBatchRecord>();
  const ledgerRows = new Map<string, StoredLedgerRowRecord>();
  const attempts = new Map<string, StoredAttemptRecord>();
  const locks = new Map<string, { batchId: string; ledgerRowId: string; lockedAt: Date }>();
  const changes = new Map<string, PendingChangeRecord>();

  return {
    changes,
    locks,
    registerApprovedChange(entry: Partial<PendingChangeRecord> & { id: string; videoId: string }) {
      const proposedValue = entry.proposedValue ?? "Proposed";
      changes.set(entry.id, {
        id: entry.id,
        videoId: entry.videoId,
        language: entry.language ?? "es",
        field: entry.field ?? "title",
        // Matches the default fresh fixture's empty localizations map below, so a test
        // that doesn't care about conflict detection doesn't accidentally trip it.
        baselineValue: entry.baselineValue ?? "",
        proposedValue,
        // Defaults to matching proposedValue ("approved and unedited since"); a test for
        // AC-BATCH-03 sub-case (c) passes an explicit mismatched approvedValue.
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

type FakeYoutubeFixture = {
  snippet: Record<string, unknown>;
  localizations: Record<string, { title: string; description: string }>;
};

function createHarness(options: {
  freshByVideoId?: Record<string, FakeYoutubeFixture | null>;
  guardrailFails?: boolean;
  backupHealthy?: boolean;
  backupFailsForVideoId?: string;
  auditFailsForVideoId?: string;
} = {}) {
  const store = createFakeStore();
  let counter = 0;

  const backupWrites: Array<{ videoId: string; snapshot: unknown }> = [];
  const fetchFreshCalls: string[] = [];
  const fetchPreliminaryCalls: string[][] = [];

  const services = createBatchServices({
    batchStore: store,
    changeSetStore: store,
    authResolver: {
      async resolve() {
        return { credentialRef: { userId: "user-1" }, accessToken: "tok", scopeSet: new Set<string>() };
      },
    },
    writeContext: {
      async assertWriteChannel(args) {
        if (options.guardrailFails) {
          throw new DomainError({ code: "WRITE_CHANNEL_MISMATCH", message: "Wrong channel" });
        }
        return { expectedChannelId: args.expectedChannelId ?? "UC_TEST", shouldPersistSelection: false, userId: "user-1" };
      },
    },
    youtubeApi: {
      async fetchFreshVideoContext(args: { videoId: string }) {
        fetchFreshCalls.push(args.videoId);
        const fixture = options.freshByVideoId?.[args.videoId];
        return fixture === undefined
          ? { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: {} }
          : fixture;
      },
      // AC-QUOTA-01 (Slice 5): prepareBatchExecution now calls this once per batch,
      // purely for an informational overview -- fetchPreliminaryCalls records each
      // call's exact videoId chunk (<=50 ids) so AC-QUOTA-01's own test can assert call
      // count/chunk size, while every other test in this file (predating this wiring)
      // continues to assert its RESULT is never what conflict/merge/backup decisions are
      // built from (that remains fetchFreshCalls' job, unchanged -- see AC-MERGE-02
      // below).
      async fetchPreliminaryBatchContext(args: { videoIds: string[] }) {
        fetchPreliminaryCalls.push([...args.videoIds]);
        return args.videoIds.map((videoId) => ({ videoId, defaultLanguage: "en" }));
      },
    },
    backup: {
      async checkInfrastructureHealth() {
        return { healthy: options.backupHealthy ?? true, error: options.backupHealthy === false ? "connection refused" : undefined };
      },
      async captureBackup(args: { videoId: string; snapshot: unknown }) {
        if (args.videoId === options.backupFailsForVideoId) {
          throw new DomainError({ code: "backup_item_failed", message: `Backup failed for ${args.videoId}` });
        }
        backupWrites.push({ videoId: args.videoId, snapshot: args.snapshot });
        return { path: `/fake/${args.videoId}.json`, capturedAt: new Date().toISOString() };
      },
    },
    audit: {
      async record(input: { videoId: string }) {
        if (input.videoId === options.auditFailsForVideoId) {
          throw new Error("simulated audit-store failure");
        }
      },
    },
    clock: { async wait() {} },
    idGenerator: () => `id-${++counter}`,
    logger: { info() {}, error() {} },
  });

  return { store, services, backupWrites, fetchFreshCalls, fetchPreliminaryCalls };
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

test("AC-GUARD-01 (= official test §55): a wrong-channel batch is rejected before any write or backup", async () => {
  const harness = createHarness({ guardrailFails: true });
  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    selections: [{ videoId: "v1", changeIds: ["c1"] }],
  });

  await assert.rejects(
    () => harness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } }),
    (error: unknown) => error instanceof DomainError && error.code === "WRITE_CHANNEL_MISMATCH"
  );

  assert.equal(harness.backupWrites.length, 0);
  assert.equal(harness.fetchFreshCalls.length, 0);

  const rows = await harness.services.listLedgerRows(batch.id);
  assert.equal(rows[0].status, "PENDING"); // never touched
});

test("AC-DRYRUN-01/02: a dry-run batch runs identity/fetch/merge/backup and lands on DRY_RUN_COMPLETE, never SUCCESS", async () => {
  const harness = createHarness({
    freshByVideoId: {
      v1: { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "Baseline", description: "Desc" } } },
    },
  });
  const batch = await createApprovedBatch(
    harness,
    { channelId: "UC_TEST", dryRun: true, selections: [{ videoId: "v1", changeIds: ["c1"] }] },
    { c1: { baselineValue: "Baseline" } } // matches this test's own fresh fixture -- no conflict
  );

  const result = await harness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, "DRY_RUN_COMPLETE");
  assert.equal(harness.backupWrites.length, 1);
  assert.equal(harness.fetchFreshCalls.length, 1);

  const finalBatch = await harness.services.getBatch(batch.id);
  assert.equal(finalBatch.status, "COMPLETED");
  const rows = await harness.services.listLedgerRows(batch.id);
  assert.equal(rows[0].status, "DRY_RUN_COMPLETE");
  assert.notEqual(rows[0].status, "SUCCESS");
});

test("a live (non-dry-run) batch prepares a payload and stops at AWAITING_EXECUTION, never an executor, in Slice 2/prepareBatchExecution alone", async () => {
  // Revised 2026-09-17 (Slice 3 "execution-state correctness" review): the row's
  // resting state after preparation-only is now the explicit AWAITING_EXECUTION status,
  // not APPLYING -- APPLYING is reserved exclusively for "an attempt is genuinely
  // active" (see contracts.ts's LedgerStatus doc and services.test.ts's beginAttempt
  // tests). This is the fix requested: a blocked live operation must have its own
  // inspectable state, never reuse APPLYING as a placeholder for "idle, prepared."
  const harness = createHarness();
  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    dryRun: false,
    selections: [{ videoId: "v1", changeIds: ["c1"] }],
  });

  const result = await harness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } });

  assert.equal(result.rows[0].status, "AWAITING_EXECUTION");
  const rows = await harness.services.listLedgerRows(batch.id);
  assert.equal(rows[0].status, "AWAITING_EXECUTION"); // prepared, not yet attempted -- never auto-advanced
  const finalBatch = await harness.services.getBatch(batch.id);
  assert.equal(finalBatch.status, "RUNNING"); // never marked COMPLETED by prepareBatchExecution alone for a live batch
});

test("AC-BATCH-03 (send-time re-check): a change revoked after batch creation blocks that video with FAILED, not CONFLICT", async () => {
  const harness = createHarness();
  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    dryRun: true,
    selections: [{ videoId: "v1", changeIds: ["c1"] }],
  });

  // Approval revoked after batch creation (AC-BATCH-03 sub-case a).
  harness.store.registerApprovedChange({ id: "c1", videoId: "v1", approvalStatus: "pending" });

  const result = await harness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } });

  assert.equal(result.rows[0].status, "FAILED");
  assert.equal(harness.backupWrites.length, 0); // never reached backup -- blocked before it
});

test("AC-BATCH-03 sub-case (c) / AC-TIMEOUT-02 (independent-review finding, 2026-09-18): a change's proposedValue edited after approval, with approvalStatus left 'approved', blocks the write -- neither the stale nor the newly-edited value is ever sent", async () => {
  const harness = createHarness();
  const batch = await createApprovedBatch(
    harness,
    { channelId: "UC_TEST", dryRun: true, selections: [{ videoId: "v1", changeIds: ["c1"] }] },
    { c1: { proposedValue: "Originally Approved Value" } }
  );
  // At this point c1 is approved with approvedValue === proposedValue === "Originally
  // Approved Value" (createHarness's registerApprovedChange default). Now simulate an
  // in-place content edit that leaves approvalStatus untouched -- approvalStatus alone
  // would wrongly pass "approved"; only the approvedValue-vs-proposedValue mismatch this
  // finding added can catch it.
  harness.store.registerApprovedChange({
    id: "c1",
    videoId: "v1",
    proposedValue: "Edited After Approval",
    approvedValue: "Originally Approved Value",
    approvalStatus: "approved",
  });

  const result = await harness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } });

  assert.equal(result.rows[0].status, "FAILED");
  assert.equal(harness.backupWrites.length, 0, "must never reach backup/payload construction with either the stale or the edited value");
});

test("independent-review finding (2026-09-18): a failure AFTER acquireVideoLock succeeds (e.g. an audit-store outage) still releases the video lock, never leaving it held under a terminal FAILED row", async () => {
  const harness = createHarness({ auditFailsForVideoId: "v1" });
  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    dryRun: true,
    selections: [{ videoId: "v1", changeIds: ["c1"] }],
  });

  const result = await harness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } });

  assert.equal(result.rows[0].status, "FAILED");
  assert.equal(
    harness.store.locks.has("v1"),
    false,
    "the video lock must be released, not leaked, when a step after acquireVideoLock throws"
  );
});

test("AC-CONFLICT-01 / AC-LEDGER-04 (service level): a baseline mismatch against the fresh fetch blocks with CONFLICT", async () => {
  const harness = createHarness({
    freshByVideoId: {
      v1: { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: { es: { title: "Changed In Studio", description: "Desc" } } },
    },
  });
  const batch = await createApprovedBatch(
    harness,
    { channelId: "UC_TEST", dryRun: true, selections: [{ videoId: "v1", changeIds: ["c1"] }] },
    { c1: { language: "es", field: "title", baselineValue: "Cuban Jazz", proposedValue: "Nuevo Titulo" } }
  );

  const result = await harness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } });

  assert.equal(result.rows[0].status, "CONFLICT");
  assert.equal(harness.backupWrites.length, 0); // conflict detected before backup
  const rows = await harness.services.listLedgerRows(batch.id);
  assert.equal(rows[0].status, "CONFLICT");
});

test("AC-MERGE-02 (RISK-03): the payload is built from fetchFreshVideoContext, never fetchPreliminaryBatchContext", async () => {
  const harness = createHarness({
    freshByVideoId: {
      v1: {
        snippet: { title: "T", description: "D", defaultLanguage: "en" },
        localizations: { es: { title: "Actually Current Titulo", description: "Desc" } },
      },
    },
  });
  const batch = await createApprovedBatch(
    harness,
    { channelId: "UC_TEST", dryRun: true, selections: [{ videoId: "v1", changeIds: ["c1"] }] },
    { c1: { language: "es", field: "title", baselineValue: "Actually Current Titulo", proposedValue: "New" } }
  );

  const result = await harness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } });

  assert.equal(result.rows[0].status, "DRY_RUN_COMPLETE");
  // Slice 5 (AC-QUOTA-01): the preliminary batched pass now runs once per batch, but its
  // result shape (videoId/defaultLanguage only, per this harness's own fixture above)
  // cannot structurally supply a title/description/localizations value at all -- the
  // per-video merge/conflict decision below is still built exclusively from
  // fetchFreshVideoContext's (deliberately different) fixture, proving the preliminary
  // pass is informational-only, never a substitute for the mandatory per-video fetch.
  assert.equal(harness.fetchPreliminaryCalls.length, 1);
  assert.deepEqual(harness.fetchPreliminaryCalls[0], ["v1"]);
  assert.equal(harness.fetchFreshCalls.length, 1);
});

test("AC-QUOTA-01: a 75-video batch dispatches the preliminary pass as a single service-level call (the adapter chunks it into <=50-id videos.list requests internally, proven separately in src/lib/youtube.test.ts), never one videos.list-equivalent call per video -- while the mandatory per-video fresh fetch still runs once per video", async () => {
  const harness = createHarness();
  const videoIds = Array.from({ length: 75 }, (_, i) => `v${i + 1}`);
  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    dryRun: true,
    selections: videoIds.map((videoId) => ({ videoId, changeIds: [`c-${videoId}`] })),
  });

  await harness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } });

  // services.ts calls the youtubeApi.fetchPreliminaryBatchContext dependency exactly
  // once per batch, with the full videoId list -- the real adapter
  // (src/lib/batches/adapters/youtube-api.ts) delegates this to
  // getVideosMetadataContextBatch, which internally issues ceil(75/50)=2 videos.list
  // calls (already proven generically for N=120 in src/lib/youtube.test.ts's
  // "chunks requests into groups of at most 50 video ids").
  assert.equal(harness.fetchPreliminaryCalls.length, 1, "the service layer dispatches one logical preliminary pass per batch, not one per video");
  assert.equal(harness.fetchPreliminaryCalls[0].length, 75);
  // The mandatory per-video fresh fetch is completely unaffected by the preliminary
  // pass -- still exactly one call per video (RISK-03/AC-MERGE-02: never batched away).
  assert.equal(harness.fetchFreshCalls.length, 75);
});

test("AC-BACKUP-04 (service level): backup infrastructure down halts the whole batch before any per-video work", async () => {
  const harness = createHarness({ backupHealthy: false });
  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    dryRun: true,
    selections: [
      { videoId: "v1", changeIds: ["c1"] },
      { videoId: "v2", changeIds: ["c2"] },
    ],
  });

  await assert.rejects(
    () => harness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } }),
    (error: unknown) => error instanceof DomainError && error.code === "backup_infrastructure_unavailable"
  );

  assert.equal(harness.fetchFreshCalls.length, 0);
  const rows = await harness.services.listLedgerRows(batch.id);
  for (const row of rows) assert.equal(row.status, "ABORTED_SYSTEMIC");
  const finalBatch = await harness.services.getBatch(batch.id);
  assert.equal(finalBatch.status, "ABORTED");
});

test("minimal isolation: one video's FAILED does not stop the rest of the batch from being prepared", async () => {
  const harness = createHarness({ backupFailsForVideoId: "v1" });
  const batch = await createApprovedBatch(harness, {
    channelId: "UC_TEST",
    dryRun: true,
    selections: [
      { videoId: "v1", changeIds: ["c1"] },
      { videoId: "v2", changeIds: ["c2"] },
    ],
  });

  const result = await harness.services.prepareBatchExecution({ batchId: batch.id, credentialRef: { userId: "user-1" } });

  const byVideo = Object.fromEntries(result.rows.map((r) => [r.videoId, r.status]));
  assert.equal(byVideo.v1, "FAILED");
  assert.equal(byVideo.v2, "DRY_RUN_COMPLETE");
});
