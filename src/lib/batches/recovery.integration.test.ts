// ---------------------------------------------------------------------------
// Real-SQLite crash-recovery tests (docs/acceptance/PHASE_5_ACCEPTANCE.md AC-CRASH-01,
// AC-ATTEMPT-04, AC-RESUME-01; the project owner's "crash recovery and persistent locks"
// review). Each test constructs a durable, on-disk state at the PERSISTENCE layer
// (directly via src/lib/db.ts's real functions) that mimics exactly what a crash at a
// specific point would leave behind, then re-opens a FRESH `createBatchServices`
// instance bound to the SAME on-disk database file (simulating an application restart --
// nothing here carries any in-memory state across the "before" and "after" halves of a
// test) and calls `recoverBatch`. Per docs/DEVELOPMENT_PLAYBOOK.md §6.11, the database is
// a temp file under os.tmpdir(); data/playlist-manager.db is never touched.
//
// Interruption points covered, per the project owner's explicit list:
//   1. before attempt-intent creation       -- row never leaves AWAITING_EXECUTION; a
//                                               restart finds nothing to recover, normal
//                                               execution can simply proceed.
//   2. after durable intent, before executor invocation
//   3. after executor invocation, before recording its result
//      (2 and 3 are indistinguishable from durable state alone, and the accepted
//      contract requires them to be handled identically -- AC-ATTEMPT-04)
//   4. after recording a result, before releasing the lock
//   5. after successful verification, before final ledger completion
//      (4 and 5 collapse to the same durable shape: attempt RESULT_RECORDED, ledger row
//      still APPLYING, lock still held -- recovery re-establishes the truth via a fresh
//      read rather than trusting the stored outcome blindly for SUCCESS)
//
// Also verifies: recoverBatch is idempotent (a second call after full recovery changes
// nothing further), locks are never released merely because of elapsed time, and no
// duplicate write is ever issued based solely on a recovered RUNNING/APPLYING status
// (there is no WriteExecutor reachable from recovery at all -- recoverLedgerRow never
// calls one).
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  getStoredLedgerRow,
  getVideoExecutionLockHolder,
  initializeDatabaseSchema,
  listStoredAttemptsByLedgerRow,
  recordAttemptResult,
  releaseVideoExecutionLock,
  transitionLedgerRowStatus,
  type AppDb,
} from "@/lib/db";
import { DomainError, type PendingChangeRecord } from "./contracts";
import { createBatchServices } from "./services";

let tempDir: string;
let client: Client;
let dbHandle: AppDb;

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "batches-recovery-"));
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

/** A "fresh process" always builds its own services instance bound to the same on-disk
 * database -- nothing is shared in memory with whatever wrote the crash state. */
function reopenServices(changeRegistry: Map<string, PendingChangeRecord>, freshFetchResult: unknown) {
  const auditEvents: Array<{ ledgerRowId: string; eventType: string; detail: unknown }> = [];
  let idCounter = 0;

  const batchStore = {
    createBatchWithLedger: (input: Parameters<typeof createBatchWithLedger>[0]) => createBatchWithLedger(input, dbHandle),
    getBatch: (id: string) => import("@/lib/db").then((m) => m.getStoredBatch(id, dbHandle)),
    listBatchesByChannel: (channelId: string) => import("@/lib/db").then((m) => m.listStoredBatchesByChannel(channelId, dbHandle)),
    listLedgerRowsByBatch: (batchId: string) => import("@/lib/db").then((m) => m.listStoredLedgerRowsByBatch(batchId, dbHandle)),
    getLedgerRow: (id: string) => getStoredLedgerRow(id, dbHandle),
    claimBatchExecution: (batchId: string, runId: string) => claimBatchExecution(batchId, runId, dbHandle),
    markBatchTerminal: (batchId: string, status: "COMPLETED" | "ABORTED") =>
      import("@/lib/db").then((m) => m.markBatchTerminal(batchId, status, dbHandle)),
    acquireVideoExecutionLock: (input: Parameters<typeof acquireVideoExecutionLock>[0]) => acquireVideoExecutionLock(input, dbHandle),
    releaseVideoExecutionLock: (input: Parameters<typeof releaseVideoExecutionLock>[0]) => releaseVideoExecutionLock(input, dbHandle),
    getVideoExecutionLockHolder: (videoId: string) => getVideoExecutionLockHolder(videoId, dbHandle),
    transitionLedgerRowStatus: (input: Parameters<typeof transitionLedgerRowStatus>[0]) => transitionLedgerRowStatus(input, dbHandle),
    beginAttemptIntent: (input: Parameters<typeof beginAttemptIntent>[0]) => beginAttemptIntent(input, dbHandle),
    recordAttemptResult: (input: Parameters<typeof recordAttemptResult>[0]) => recordAttemptResult(input, dbHandle),
    listAttemptsByLedgerRow: (id: string) => listStoredAttemptsByLedgerRow(id, dbHandle),
    listAttemptsByBatch: (batchId: string) => import("@/lib/db").then((m) => m.listStoredAttemptsByBatch(batchId, dbHandle)),
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
      async fetchFreshVideoContext() {
        return freshFetchResult as never;
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
    audit: {
      async record(input) {
        auditEvents.push({ ledgerRowId: input.ledgerRowId, eventType: input.eventType, detail: input.detail });
      },
    },
    clock: { async wait() {} },
    idGenerator: () => `id-${++idCounter}-${randomUUID()}`,
    logger: { info() {}, error() {} },
  });
}

function approvedChange(id: string, videoId: string): PendingChangeRecord {
  return {
    id,
    videoId,
    language: "es",
    field: "title",
    baselineValue: "",
    proposedValue: "New Value",
    approvedValue: "New Value",
    approvalStatus: "approved",
    validationStatus: "valid",
    conflictStatus: "none",
  };
}

async function setUpCrashedRow(videoId: string): Promise<{ batchId: string; ledgerRowId: string }> {
  const batchId = randomUUID();
  const ledgerRowId = randomUUID();
  await createBatchWithLedger(
    {
      id: batchId,
      channelId: "UC_TEST",
      concurrency: 1,
      dryRun: false,
      ledgerRows: [{ id: ledgerRowId, videoId, changeIds: [`change-${videoId}`] }],
    },
    dbHandle
  );
  await claimBatchExecution(batchId, "run-1", dbHandle);
  await transitionLedgerRowStatus({ ledgerRowId, from: ["PENDING"], to: "AWAITING_EXECUTION" }, dbHandle);
  await acquireVideoExecutionLock({ videoId, batchId, ledgerRowId }, dbHandle);
  await transitionLedgerRowStatus({ ledgerRowId, from: ["AWAITING_EXECUTION"], to: "APPLYING" }, dbHandle);
  return { batchId, ledgerRowId };
}

test("Interruption point 1 (before attempt-intent creation): nothing to recover, row stays AWAITING_EXECUTION", async () => {
  const videoId = "v-crash-1";
  const batchId = randomUUID();
  const ledgerRowId = randomUUID();
  await createBatchWithLedger(
    { id: batchId, channelId: "UC_TEST", concurrency: 1, dryRun: false, ledgerRows: [{ id: ledgerRowId, videoId, changeIds: [`change-${videoId}`] }] },
    dbHandle
  );
  await claimBatchExecution(batchId, "run-1", dbHandle);
  await transitionLedgerRowStatus({ ledgerRowId, from: ["PENDING"], to: "AWAITING_EXECUTION" }, dbHandle);
  await acquireVideoExecutionLock({ videoId, batchId, ledgerRowId }, dbHandle);
  // Crash happens right here -- lock acquired, row prepared, but beginAttempt was never
  // even called.

  const changes = new Map([[`change-${videoId}`, approvedChange(`change-${videoId}`, videoId)]]);
  const services = reopenServices(changes, null);
  const result = await services.recoverBatch({ batchId, credentialRef: { userId: "user-1" } });

  assert.equal(result.recovered.length, 0);
  const row = await getStoredLedgerRow(ledgerRowId, dbHandle);
  assert.equal(row?.status, "AWAITING_EXECUTION");
  // Lock is still held -- correctly, since a live execution can resume from here.
  const holder = await getVideoExecutionLockHolder(videoId, dbHandle);
  assert.equal(holder?.batchId, batchId);
});

test("Interruption points 2/3 (durable intent exists, network call unknown): recovered as UNKNOWN via reconciliation, never a blind retry", async () => {
  const videoId = "v-crash-2";
  const { batchId, ledgerRowId } = await setUpCrashedRow(videoId);

  const attemptId = randomUUID();
  await beginAttemptIntent({ id: attemptId, ledgerRowId, attemptNumber: 1, payloadSnapshot: { title: "New Value" } }, dbHandle);
  // Crash happens right here -- INTENDED durably committed, but whether the network call
  // was ever issued (sub-case 2) or issued-but-unresolved (sub-case 3) is indistinguishable.

  const changes = new Map([[`change-${videoId}`, approvedChange(`change-${videoId}`, videoId)]]);
  // Reconciliation's two reads both show the pre-write baseline -- insufficient evidence,
  // must resolve to UNKNOWN, never a retry.
  const services = reopenServices(changes, { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: {} });

  const result = await services.recoverBatch({ batchId, credentialRef: { userId: "user-1" } });

  assert.equal(result.recovered.length, 1);
  assert.equal(result.recovered[0].resultingStatus, "UNKNOWN");
  const row = await getStoredLedgerRow(ledgerRowId, dbHandle);
  assert.equal(row?.status, "UNKNOWN");
  // The lock is still held for the UNKNOWN row -- never released merely because time
  // elapsed, and no other batch could have reacquired it.
  const holder = await getVideoExecutionLockHolder(videoId, dbHandle);
  assert.equal(holder?.batchId, batchId);
  // Exactly one attempt total exists -- recovery never issued a second (duplicate) one.
  const attempts = await listStoredAttemptsByLedgerRow(ledgerRowId, dbHandle);
  assert.equal(attempts.length, 1);

  // Idempotency: a second recovery pass for an already-UNKNOWN row is a deliberate,
  // separate reconciliation pass (§0.F), not part of ordinary crash recovery -- recovery
  // itself only acts on APPLYING rows, so calling it again changes nothing further.
  const secondPass = await services.recoverBatch({ batchId, credentialRef: { userId: "user-1" } });
  assert.equal(secondPass.recovered.length, 0);
});

test("Interruption point 4 (result recorded, ledger not finalized, FAILED outcome): finalized to FAILED and lock released", async () => {
  const videoId = "v-crash-4";
  const { batchId, ledgerRowId } = await setUpCrashedRow(videoId);

  const attemptId = randomUUID();
  await beginAttemptIntent({ id: attemptId, ledgerRowId, attemptNumber: 1, payloadSnapshot: { title: "New Value" } }, dbHandle);
  await recordAttemptResult({ attemptId, outcome: "FAILED", outcomeDetail: "insufficient permissions" }, dbHandle);
  // Crash happens right here -- attempt is RESULT_RECORDED, but the ledger row never
  // transitioned out of APPLYING and the lock was never released.

  const changes = new Map([[`change-${videoId}`, approvedChange(`change-${videoId}`, videoId)]]);
  const services = reopenServices(changes, null);

  const result = await services.recoverBatch({ batchId, credentialRef: { userId: "user-1" } });

  assert.equal(result.recovered[0].resultingStatus, "FAILED");
  const row = await getStoredLedgerRow(ledgerRowId, dbHandle);
  assert.equal(row?.status, "FAILED");
  assert.equal(row?.error, "insufficient permissions");
  const holder = await getVideoExecutionLockHolder(videoId, dbHandle);
  assert.equal(holder, null); // released -- a terminal row never holds a lock

  // Idempotency: second pass finds a terminal row, nothing to recover.
  const secondPass = await services.recoverBatch({ batchId, credentialRef: { userId: "user-1" } });
  assert.equal(secondPass.recovered.length, 0);
});

test("Interruption point 5 (successful verification recorded, ledger not finalized): re-verified and finalized to SUCCESS", async () => {
  const videoId = "v-crash-5";
  const { batchId, ledgerRowId } = await setUpCrashedRow(videoId);

  const attemptId = randomUUID();
  await beginAttemptIntent({ id: attemptId, ledgerRowId, attemptNumber: 1, payloadSnapshot: { title: "New Value" } }, dbHandle);
  await recordAttemptResult({ attemptId, outcome: "SUCCESS", outcomeDetail: null }, dbHandle);
  // Crash happens right here -- the attempt's own response was SUCCESS and recorded, but
  // the crash occurred before recovery could even know whether verification already ran.

  const changes = new Map([[`change-${videoId}`, approvedChange(`change-${videoId}`, videoId)]]);
  // Fresh re-verification shows the requested value -- confirms the write really applied.
  const services = reopenServices(changes, {
    snippet: { title: "T", description: "D", defaultLanguage: "en" },
    localizations: { es: { title: "New Value", description: "" } },
  });

  const result = await services.recoverBatch({ batchId, credentialRef: { userId: "user-1" } });

  assert.equal(result.recovered[0].resultingStatus, "SUCCESS");
  const row = await getStoredLedgerRow(ledgerRowId, dbHandle);
  assert.equal(row?.status, "SUCCESS");
  assert.ok(row?.verificationResult);
  const holder = await getVideoExecutionLockHolder(videoId, dbHandle);
  assert.equal(holder, null);
});

test("Interruption point 5 variant: a recorded SUCCESS that re-verification cannot confirm is finalized to FAILED, never trusted blindly", async () => {
  const videoId = "v-crash-5b";
  const { batchId, ledgerRowId } = await setUpCrashedRow(videoId);

  const attemptId = randomUUID();
  await beginAttemptIntent({ id: attemptId, ledgerRowId, attemptNumber: 1, payloadSnapshot: { title: "New Value" } }, dbHandle);
  await recordAttemptResult({ attemptId, outcome: "SUCCESS", outcomeDetail: null }, dbHandle);

  const changes = new Map([[`change-${videoId}`, approvedChange(`change-${videoId}`, videoId)]]);
  // Fresh re-verification shows neither baseline nor requested -- the recorded SUCCESS
  // cannot be confirmed and must not be trusted on its own.
  const services = reopenServices(changes, {
    snippet: { title: "T", description: "D", defaultLanguage: "en" },
    localizations: { es: { title: "Someone Else's Edit", description: "" } },
  });

  const result = await services.recoverBatch({ batchId, credentialRef: { userId: "user-1" } });

  assert.equal(result.recovered[0].resultingStatus, "FAILED");
});

test("recoverLedgerRow never invokes a WriteExecutor -- no duplicate write is possible from recovery alone", async () => {
  // Structural check: recoverBatch's signature has no `executor` parameter at all, so no
  // call to it can supply one -- reinforced by this test actually running full recovery
  // (with a real reconciliation path) without ever constructing a WriteExecutor.
  const videoId = "v-crash-6";
  const { batchId, ledgerRowId } = await setUpCrashedRow(videoId);
  const attemptId = randomUUID();
  await beginAttemptIntent({ id: attemptId, ledgerRowId, attemptNumber: 1, payloadSnapshot: {} }, dbHandle);

  const changes = new Map([[`change-${videoId}`, approvedChange(`change-${videoId}`, videoId)]]);
  const services = reopenServices(changes, { snippet: { title: "T", description: "D", defaultLanguage: "en" }, localizations: {} });

  // @ts-expect-error -- recoverBatch intentionally has no executor parameter to pass.
  await services.recoverBatch({ batchId, credentialRef: { userId: "user-1" }, executor: { attemptWrite: async () => { throw new Error("must never be called"); } } });

  const attempts = await listStoredAttemptsByLedgerRow(ledgerRowId, dbHandle);
  assert.equal(attempts.length, 1); // still just the original crashed one
});

test("resolveUnknownLedgerRow throws for a row still APPLYING (systemic guard against calling it before it is actually UNKNOWN)", async () => {
  const videoId = "v-crash-7";
  const { batchId, ledgerRowId } = await setUpCrashedRow(videoId);
  void batchId;

  const changes = new Map([[`change-${videoId}`, approvedChange(`change-${videoId}`, videoId)]]);
  const services = reopenServices(changes, null);

  await assert.rejects(
    () => services.resolveUnknownLedgerRow({ ledgerRowId, credentialRef: { userId: "user-1" } }),
    (error: unknown) => error instanceof DomainError && error.code === "ledger_invalid_transition"
  );
});
