// ---------------------------------------------------------------------------
// AC-RESUME-01 (= official test §54, docs/acceptance/PHASE_5_ACCEPTANCE.md), full
// scenario, run at the exact scale and per-video state-class breakdown the acceptance
// contract specifies -- NOT a substitute assembled from the smaller, individual
// interruption-point tests in recovery.integration.test.ts (those remain valid and
// unchanged; this file additionally proves they compose correctly at scale).
//
// Real, persistent, on-disk SQLite (not in-memory/fake-store) -- the database is closed
// and a brand-new `createBatchServices` instance is built against the SAME file to
// simulate an actual process restart, per docs/DEVELOPMENT_PLAYBOOK.md §6.11's
// established convention for exactly this class of guarantee. A mocked YouTube adapter
// only -- no real network/credentials anywhere (INV-9).
//
// Fixture, per the acceptance contract verbatim:
//   - v1..v43   (43 videos) -- already SUCCESS before interruption.
//   - v44..v97  (54 videos) -- PENDING, never attempted before interruption.
//   - v98       (1 video)   -- APPLYING, attempt durably INTENDED with no result; the
//                              write actually reached YouTube (crash-recovery
//                              reconciliation resolves it to SUCCESS, AC-CRASH-01 shape).
//   - v99       (1 video)   -- APPLYING, attempt durably INTENDED with no result; the
//                              write's fate is genuinely undeterminable (two consistent
//                              baseline reads -> UNKNOWN, AC-TIMEOUT-01 sub-case 2 shape).
//   - v100      (1 video)   -- already FAILED for a definitive, non-systemic,
//                              non-retryable reason before the interruption occurred.
// Total: 43 + 54 + 1 + 1 + 1 = 100.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createClient, type Client } from "@libsql/client";
import {
  acquireVideoExecutionLock,
  beginAttemptIntent,
  channels,
  claimBatchExecution,
  createBatchWithLedger,
  createIsolatedDb,
  getVideoExecutionLockHolder,
  initializeDatabaseSchema,
  listStoredAttemptsByBatch,
  listStoredLedgerRowsByBatch,
  markBatchTerminal,
  recordAttemptResult,
  releaseVideoExecutionLock,
  transitionLedgerRowStatus,
  type AppDb,
} from "@/lib/db";
import type { PendingChangeRecord, WriteExecutor, WriteExecutorResult } from "./contracts";
import { createBatchServices } from "./services";

let tempDir: string;
let client: Client;
let dbHandle: AppDb;

const BATCH_ID = "batch-100";
const N_SUCCESS_BEFORE = 43;
const N_PENDING = 54;
const successVideoIds = Array.from({ length: N_SUCCESS_BEFORE }, (_, i) => `v${i + 1}`);
const pendingVideoIds = Array.from({ length: N_PENDING }, (_, i) => `v${i + 1 + N_SUCCESS_BEFORE}`);
const CRASHED_APPLIED = "v98";
const CRASHED_UNKNOWN = "v99";
const PRE_FAILED = "v100";
const allVideoIds = [...successVideoIds, ...pendingVideoIds, CRASHED_APPLIED, CRASHED_UNKNOWN, PRE_FAILED];

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "batches-resume-100-"));
  client = createClient({ url: `file:${path.join(tempDir, "test.db")}` });
  await initializeDatabaseSchema(client);
  dbHandle = createIsolatedDb(client);

  await dbHandle.insert(channels).values({
    id: "UC_TEST",
    title: "Test Channel",
    thumbnailUrl: null,
    uploadsPlaylistId: "UU_TEST",
    connectedUserId: null,
  });
});

after(async () => {
  client.close();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function approvedChange(videoId: string): PendingChangeRecord {
  return {
    id: `change-${videoId}`,
    videoId,
    language: "es",
    field: "title",
    baselineValue: "Old",
    proposedValue: "New",
    approvedValue: "New",
    approvalStatus: "approved",
    validationStatus: "valid",
    conflictStatus: "none",
  };
}

async function driveToSuccess(videoId: string) {
  const ledgerRowId = `row-${videoId}`;
  await transitionLedgerRowStatus({ ledgerRowId, from: ["PENDING"], to: "AWAITING_EXECUTION" }, dbHandle);
  await acquireVideoExecutionLock({ videoId, batchId: BATCH_ID, ledgerRowId }, dbHandle);
  await transitionLedgerRowStatus({ ledgerRowId, from: ["AWAITING_EXECUTION"], to: "APPLYING" }, dbHandle);
  const attemptId = `attempt-${videoId}-1`;
  await beginAttemptIntent({ id: attemptId, ledgerRowId, attemptNumber: 1, payloadSnapshot: { videoId } }, dbHandle);
  await recordAttemptResult({ attemptId, outcome: "SUCCESS", outcomeDetail: null }, dbHandle);
  await transitionLedgerRowStatus(
    { ledgerRowId, from: ["APPLYING"], to: "SUCCESS", verificationResult: { resolvedVia: "own_response", ownResponseObserved: true } },
    dbHandle
  );
  await releaseVideoExecutionLock({ videoId, batchId: BATCH_ID }, dbHandle);
}

async function driveToPreFailed(videoId: string) {
  const ledgerRowId = `row-${videoId}`;
  await transitionLedgerRowStatus({ ledgerRowId, from: ["PENDING"], to: "AWAITING_EXECUTION" }, dbHandle);
  await acquireVideoExecutionLock({ videoId, batchId: BATCH_ID, ledgerRowId }, dbHandle);
  await transitionLedgerRowStatus({ ledgerRowId, from: ["AWAITING_EXECUTION"], to: "APPLYING" }, dbHandle);
  const attemptId = `attempt-${videoId}-1`;
  await beginAttemptIntent({ id: attemptId, ledgerRowId, attemptNumber: 1, payloadSnapshot: { videoId } }, dbHandle);
  await recordAttemptResult({ attemptId, outcome: "FAILED", outcomeDetail: "invalid metadata (test fixture)" }, dbHandle);
  await transitionLedgerRowStatus({ ledgerRowId, from: ["APPLYING"], to: "FAILED", error: "invalid metadata (test fixture)" }, dbHandle);
  await releaseVideoExecutionLock({ videoId, batchId: BATCH_ID }, dbHandle);
}

/** Leaves the row APPLYING with a durable INTENDED attempt and no result -- the
 * indistinguishable-from-durable-state-alone crash shape both AC-CRASH-01 (v98, applied)
 * and AC-TIMEOUT-01 sub-case 2 (v99, undeterminable) share, per §0.C/AC-ATTEMPT-04. */
async function driveToCrashedApplying(videoId: string) {
  const ledgerRowId = `row-${videoId}`;
  await transitionLedgerRowStatus({ ledgerRowId, from: ["PENDING"], to: "AWAITING_EXECUTION" }, dbHandle);
  await acquireVideoExecutionLock({ videoId, batchId: BATCH_ID, ledgerRowId }, dbHandle);
  await transitionLedgerRowStatus({ ledgerRowId, from: ["AWAITING_EXECUTION"], to: "APPLYING" }, dbHandle);
  const attemptId = `attempt-${videoId}-1`;
  await beginAttemptIntent({ id: attemptId, ledgerRowId, attemptNumber: 1, payloadSnapshot: { videoId } }, dbHandle);
  // Deliberately no recordAttemptResult / no ledger transition -- this IS the crash.
}

type Instrumentation = { attemptCounts: Map<string, number> };

/** Bound to `dbHandle` -- mirrors recovery.integration.test.ts's `reopenServices`
 * pattern exactly, simulating a fresh process reopening the same on-disk database. */
function reopenServices(instr: Instrumentation, remoteState: Map<string, string>) {
  const changeRegistry = new Map<string, PendingChangeRecord>(allVideoIds.map((videoId) => [`change-${videoId}`, approvedChange(videoId)]));

  const batchStore = {
    createBatchWithLedger: (input: Parameters<typeof createBatchWithLedger>[0]) => createBatchWithLedger(input, dbHandle),
    getBatch: (id: string) => import("@/lib/db").then((m) => m.getStoredBatch(id, dbHandle)),
    listBatchesByChannel: (channelId: string) => import("@/lib/db").then((m) => m.listStoredBatchesByChannel(channelId, dbHandle)),
    listLedgerRowsByBatch: (batchId: string) => listStoredLedgerRowsByBatch(batchId, dbHandle),
    getLedgerRow: (id: string) => import("@/lib/db").then((m) => m.getStoredLedgerRow(id, dbHandle)),
    claimBatchExecution: (batchId: string, runId: string) => claimBatchExecution(batchId, runId, dbHandle),
    markBatchTerminal: (batchId: string, status: "COMPLETED" | "ABORTED") => markBatchTerminal(batchId, status, dbHandle),
    acquireVideoExecutionLock: (input: Parameters<typeof acquireVideoExecutionLock>[0]) => acquireVideoExecutionLock(input, dbHandle),
    releaseVideoExecutionLock: (input: Parameters<typeof releaseVideoExecutionLock>[0]) => releaseVideoExecutionLock(input, dbHandle),
    getVideoExecutionLockHolder: (videoId: string) => getVideoExecutionLockHolder(videoId, dbHandle),
    transitionLedgerRowStatus: (input: Parameters<typeof transitionLedgerRowStatus>[0]) => transitionLedgerRowStatus(input, dbHandle),
    beginAttemptIntent: (input: Parameters<typeof beginAttemptIntent>[0]) => beginAttemptIntent(input, dbHandle),
    recordAttemptResult: (input: Parameters<typeof recordAttemptResult>[0]) => recordAttemptResult(input, dbHandle),
    listAttemptsByLedgerRow: (id: string) => import("@/lib/db").then((m) => m.listStoredAttemptsByLedgerRow(id, dbHandle)),
    listAttemptsByBatch: (batchId: string) => listStoredAttemptsByBatch(batchId, dbHandle),
    getAttempt: (id: string) => import("@/lib/db").then((m) => m.getStoredAttempt(id, dbHandle)),
  };

  return createBatchServices({
    batchStore,
    changeSetStore: { async getChange(id: string) { return changeRegistry.get(id) ?? null; } },
    authResolver: {
      async resolve() {
        return { credentialRef: { userId: "user-1" }, accessToken: "tok", scopeSet: new Set<string>() };
      },
    },
    writeContext: {
      async assertWriteChannel(args) {
        return { expectedChannelId: args.expectedChannelId ?? "UC_TEST", shouldPersistSelection: false, userId: "user-1" };
      },
    },
    youtubeApi: {
      async fetchFreshVideoContext(args: { videoId: string }) {
        const title = remoteState.get(args.videoId) ?? "Old";
        return { snippet: { title: "Old", description: "Old", defaultLanguage: "en" }, localizations: { es: { title, description: "Old" } } };
      },
    },
    backup: {
      async checkInfrastructureHealth() {
        return { healthy: true };
      },
      async captureBackup() {
        return { path: "/fake/backup.json", capturedAt: new Date().toISOString() };
      },
    },
    audit: { async record() {} },
    clock: { async wait() {} },
    idGenerator: (() => {
      let n = 0;
      return () => `resume-id-${++n}`;
    })(),
    logger: { info() {}, error() {} },
  });
}

test("AC-RESUME-01 (= official test §54): complete 100-video interrupted-batch resume, exact acceptance-contract fixture", async () => {
  // --- Phase 1: construct the batch and drive it to the exact pre-interruption state ---
  await createBatchWithLedger(
    {
      id: BATCH_ID,
      channelId: "UC_TEST",
      concurrency: 1,
      dryRun: false,
      ledgerRows: allVideoIds.map((videoId) => ({ id: `row-${videoId}`, videoId, changeIds: [`change-${videoId}`] })),
    },
    dbHandle
  );
  await claimBatchExecution(BATCH_ID, "run-before-crash", dbHandle);

  for (const videoId of successVideoIds) await driveToSuccess(videoId);
  // pendingVideoIds: left untouched, still PENDING from creation.
  await driveToCrashedApplying(CRASHED_APPLIED);
  await driveToCrashedApplying(CRASHED_UNKNOWN);
  await driveToPreFailed(PRE_FAILED);

  // Sanity-check the fixture itself before simulating the restart.
  const preInterruptionRows = await listStoredLedgerRowsByBatch(BATCH_ID, dbHandle);
  assert.equal(preInterruptionRows.length, 100);
  assert.equal(preInterruptionRows.filter((r) => r.status === "SUCCESS").length, 43);
  assert.equal(preInterruptionRows.filter((r) => r.status === "PENDING").length, 54);
  assert.equal(preInterruptionRows.filter((r) => r.status === "APPLYING").length, 2);
  assert.equal(preInterruptionRows.filter((r) => r.status === "FAILED").length, 1);

  // --- Phase 2: "restart" -- fresh services instance, same on-disk database ---
  const instr: Instrumentation = { attemptCounts: new Map() };
  const remoteState = new Map<string, string>([[CRASHED_APPLIED, "New"]]); // the crashed write DID reach YouTube for v98, never for v99.
  const executor: WriteExecutor = {
    async attemptWrite(payload: unknown): Promise<WriteExecutorResult> {
      const videoId = (payload as { videoId: string }).videoId;
      instr.attemptCounts.set(videoId, (instr.attemptCounts.get(videoId) ?? 0) + 1);
      remoteState.set(videoId, "New");
      return { outcome: "SUCCESS" };
    },
  };

  const services = reopenServices(instr, remoteState);

  // Recovery first (resolves the two APPLYING/INTENDED rows), then continue the batch
  // (drives the 54 PENDING rows through the normal pipeline) -- exactly the two-step
  // "re-invoke the same batch id" flow AC-RESUME-01 describes.
  const recovery = await services.recoverBatch({ batchId: BATCH_ID, credentialRef: { userId: "user-1" } });
  const summary = await services.executeBatch({ batchId: BATCH_ID, credentialRef: { userId: "user-1" }, executor });

  // --- Assertions -----------------------------------------------------------------

  // Zero additional writes for the 43 already-successful videos, or for v98 (resolved
  // by reconciliation alone, never a new attemptWrite), v99 (UNKNOWN, never resent), or
  // v100 (terminal FAILED before interruption, not auto-retried on resume).
  for (const videoId of [...successVideoIds, CRASHED_APPLIED, CRASHED_UNKNOWN, PRE_FAILED]) {
    assert.equal(instr.attemptCounts.get(videoId), undefined, `${videoId} must receive zero new attemptWrite calls during resume`);
  }
  // Exactly one write per resumed PENDING video -- no duplicates.
  for (const videoId of pendingVideoIds) {
    assert.equal(instr.attemptCounts.get(videoId), 1, `${videoId} must be attempted exactly once`);
  }

  // v98 recovered to SUCCESS via reconciliation (AC-CRASH-01 shape).
  const v98Recovery = recovery.recovered.find((r) => r.videoId === CRASHED_APPLIED);
  assert.ok(v98Recovery, "v98 must appear in the recovery report");
  assert.equal(v98Recovery!.previousStatus, "APPLYING");
  assert.equal(v98Recovery!.resultingStatus, "SUCCESS");

  // v99 recovered to UNKNOWN, not silently dropped, not auto-resent.
  const v99Recovery = recovery.recovered.find((r) => r.videoId === CRASHED_UNKNOWN);
  assert.ok(v99Recovery, "v99 must appear in the recovery report");
  assert.equal(v99Recovery!.previousStatus, "APPLYING");
  assert.equal(v99Recovery!.resultingStatus, "UNKNOWN");

  // --- Final report: query persisted state directly, independent of in-memory
  // summaries, and require every one of the 100 videos to be present with a correct,
  // non-omitted status (AC-RESUME-01's "no video silently missing" requirement). ---
  const finalRows = await listStoredLedgerRowsByBatch(BATCH_ID, dbHandle);
  assert.equal(finalRows.length, 100, "no video may be silently dropped from the ledger");
  const finalByVideo = new Map(finalRows.map((r) => [r.videoId, r]));

  let successCount = 0;
  let unknownCount = 0;
  let failedCount = 0;
  for (const videoId of allVideoIds) {
    const row = finalByVideo.get(videoId);
    assert.ok(row, `${videoId} missing from the final resume report`);
    assert.ok(
      row!.status === "SUCCESS" || row!.status === "UNKNOWN" || row!.status === "FAILED",
      `${videoId} must have a terminal or explicitly-pending-manual-decision status, got ${row!.status}`
    );
    if (row!.status === "SUCCESS") successCount++;
    if (row!.status === "UNKNOWN") unknownCount++;
    if (row!.status === "FAILED") failedCount++;
  }

  // 43 original + v98 (reconciled) + 54 resumed PENDING = 98 SUCCESS; v99 UNKNOWN; v100 FAILED.
  assert.equal(successCount, 43 + 1 + 54);
  assert.equal(unknownCount, 1);
  assert.equal(failedCount, 1);
  assert.equal(finalByVideo.get(CRASHED_UNKNOWN)!.status, "UNKNOWN");
  assert.equal(finalByVideo.get(PRE_FAILED)!.status, "FAILED");

  // executeBatch's own summary must also account for all 100 (recovered rows included,
  // since listLedgerRowsByBatch is re-read fresh at the top of executeBatch).
  assert.equal(summary.results.length, 100);
  assert.equal(summary.haltedSystemically, false);

  // Persistent locks recover safely: every terminal video's lock is released; the
  // still-`UNKNOWN` v99 deliberately keeps its lock (per §0.F's "never reacquirable
  // while unresolved" rule) until an explicit operator decision or a later independent
  // reconciliation pass -- this is not a leak, it is the documented safety behavior.
  for (const videoId of [...successVideoIds, ...pendingVideoIds, CRASHED_APPLIED, PRE_FAILED]) {
    const holder = await getVideoExecutionLockHolder(videoId, dbHandle);
    assert.equal(holder, null, `${videoId}'s lock must be released once terminal`);
  }
  const v99Lock = await getVideoExecutionLockHolder(CRASHED_UNKNOWN, dbHandle);
  assert.ok(v99Lock, "v99 (UNKNOWN) must still hold its lock -- never reacquirable while unresolved");
  assert.equal(v99Lock!.batchId, BATCH_ID);

  // No duplicate ledger/attempt records: exactly one attempt row per video that was ever
  // actually attempted (the original 43 + v98's crashed attempt + v99's crashed attempt
  // + v100's pre-failed attempt + one fresh attempt per resumed PENDING video).
  const allAttempts = await listStoredAttemptsByBatch(BATCH_ID, dbHandle);
  const attemptsByVideo = new Map<string, number>();
  for (const attempt of allAttempts) {
    const row = finalRows.find((r) => r.id === attempt.ledgerRowId);
    if (!row) continue;
    attemptsByVideo.set(row.videoId, (attemptsByVideo.get(row.videoId) ?? 0) + 1);
  }
  for (const videoId of [...successVideoIds, CRASHED_APPLIED, CRASHED_UNKNOWN, PRE_FAILED, ...pendingVideoIds]) {
    assert.equal(attemptsByVideo.get(videoId), 1, `${videoId} must have exactly one attempt record, no duplicates`);
  }
});
