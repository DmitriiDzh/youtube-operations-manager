// ---------------------------------------------------------------------------
// AC-CONCURRENCY-01 (docs/acceptance/PHASE_5_ACCEPTANCE.md): real bounded-concurrency
// execution, against a real on-disk SQLite database (per docs/DEVELOPMENT_PLAYBOOK.md
// §6.11's convention for exactly this kind of guarantee -- a fake in-memory store could
// hide a real persistence-layer race). Verifies, per this task's explicit checklist:
//   - no more than K in-flight attemptWrite calls at any instant (K=1 and K=3);
//   - K=3 actually parallelizes (does not silently degrade to serial);
//   - persistent video locks and active-attempt exclusivity hold under real concurrency;
//   - no duplicate writes (each video's attemptWrite is called exactly once);
//   - each video's own audit sequence stays correctly ordered despite cross-video
//     interleaving;
//   - a systemic failure halts not-yet-started rows without touching already-completed
//     ones or interrupting rows already in flight.
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
  getStoredAttempt,
  getStoredBatch,
  listStoredBatchesByChannel,
  getStoredLedgerRow,
  getVideoExecutionLockHolder,
  initializeDatabaseSchema,
  listStoredAttemptsByBatch,
  listStoredAttemptsByLedgerRow,
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

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "batches-concurrency-exec-"));
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

function approvedChange(id: string, videoId: string): PendingChangeRecord {
  return {
    id,
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

type Instrumentation = {
  maxInFlight: number;
  attemptCounts: Map<string, number>;
  auditLog: Array<{ videoId: string; eventType: string }>;
};

/** Every `attemptWrite` call holds `delayMs` before resolving, letting real overlap
 * between concurrently-dispatched rows actually occur (rather than relying on manual
 * synchronization) -- this is a real, real-clock-timed integration test, not a fake.
 * Updates `remoteState` on SUCCESS so the mandatory post-write verification fetch sees
 * the applied value. */
function createInstrumentedExecutor(instr: Instrumentation, delayMs: number, remoteState: Map<string, string>) {
  let inFlight = 0;
  const executor: WriteExecutor = {
    async attemptWrite(payload: unknown): Promise<WriteExecutorResult> {
      const videoId = (payload as { videoId: string }).videoId;
      instr.attemptCounts.set(videoId, (instr.attemptCounts.get(videoId) ?? 0) + 1);

      inFlight++;
      instr.maxInFlight = Math.max(instr.maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight--;

      remoteState.set(videoId, "New");
      return { outcome: "SUCCESS" };
    },
  };
  return executor;
}

/** Bound to `dbHandle` (the isolated test database) -- `createBatchStoreAdapter()` in
 * production code always binds to the production singleton, so it cannot be used here;
 * this mirrors recovery.integration.test.ts's `reopenServices` pattern exactly. */
function isolatedBatchStore() {
  return {
    createBatchWithLedger: (input: Parameters<typeof createBatchWithLedger>[0]) => createBatchWithLedger(input, dbHandle),
    getBatch: (id: string) => getStoredBatch(id, dbHandle),
    listBatchesByChannel: (channelId: string) => listStoredBatchesByChannel(channelId, dbHandle),
    listLedgerRowsByBatch: (batchId: string) => listStoredLedgerRowsByBatch(batchId, dbHandle),
    getLedgerRow: (id: string) => getStoredLedgerRow(id, dbHandle),
    claimBatchExecution: (batchId: string, runId: string) => claimBatchExecution(batchId, runId, dbHandle),
    markBatchTerminal: (batchId: string, status: "COMPLETED" | "ABORTED") => markBatchTerminal(batchId, status, dbHandle),
    acquireVideoExecutionLock: (input: Parameters<typeof acquireVideoExecutionLock>[0]) => acquireVideoExecutionLock(input, dbHandle),
    releaseVideoExecutionLock: (input: Parameters<typeof releaseVideoExecutionLock>[0]) => releaseVideoExecutionLock(input, dbHandle),
    getVideoExecutionLockHolder: (videoId: string) => getVideoExecutionLockHolder(videoId, dbHandle),
    transitionLedgerRowStatus: (input: Parameters<typeof transitionLedgerRowStatus>[0]) => transitionLedgerRowStatus(input, dbHandle),
    beginAttemptIntent: (input: Parameters<typeof beginAttemptIntent>[0]) => beginAttemptIntent(input, dbHandle),
    recordAttemptResult: (input: Parameters<typeof recordAttemptResult>[0]) => recordAttemptResult(input, dbHandle),
    listAttemptsByLedgerRow: (id: string) => listStoredAttemptsByLedgerRow(id, dbHandle),
    listAttemptsByBatch: (batchId: string) => listStoredAttemptsByBatch(batchId, dbHandle),
    getAttempt: (id: string) => getStoredAttempt(id, dbHandle),
  };
}

/** Per-video "remote" title, mutated by the executor on a real SUCCESS so that the
 * mandatory post-write verification fetch (AC-VERIFY-01/02) sees the applied value --
 * a stateless mock would fail verification (it would still report the pre-write
 * baseline), so this fake must behave like a real remote store: pre-write fetch and
 * pre-write conflict detection see "Old", post-write verification sees "New" once
 * (and only once) the corresponding attemptWrite has resolved SUCCESS. */
function buildServices(changeRegistry: Map<string, PendingChangeRecord>, instr: Instrumentation, remoteState: Map<string, string>) {
  return createBatchServices({
    batchStore: isolatedBatchStore(),
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
        return {
          snippet: { title, description: "Old", defaultLanguage: "es" },
          localizations: {},
        };
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
        instr.auditLog.push({ videoId: input.videoId, eventType: input.eventType });
      },
    },
    clock: { async wait() {} },
    idGenerator: () => randomUUID(),
    logger: { info() {}, error() {} },
  });
}

async function setUpBatch(
  services: ReturnType<typeof buildServices>,
  changeRegistry: Map<string, PendingChangeRecord>,
  videoIds: string[],
  concurrency: number
) {
  for (const videoId of videoIds) {
    changeRegistry.set(`change-${videoId}`, approvedChange(`change-${videoId}`, videoId));
  }
  const batch = await services.createBatch({
    channelId: "UC_TEST",
    concurrency,
    dryRun: false,
    selections: videoIds.map((videoId) => ({ videoId, changeIds: [`change-${videoId}`] })),
  });
  return batch;
}

test("AC-CONCURRENCY-01 (K=1, real SQLite): never more than 1 attemptWrite in flight, fully sequential by default", async () => {
  const instr: Instrumentation = { maxInFlight: 0, attemptCounts: new Map(), auditLog: [] };
  const changeRegistry = new Map<string, PendingChangeRecord>();
  const remoteState = new Map<string, string>();
  const services = buildServices(changeRegistry, instr, remoteState);
  const videoIds = ["k1-v1", "k1-v2", "k1-v3", "k1-v4"];

  const batch = await setUpBatch(services, changeRegistry, videoIds, 1);
  const executor = createInstrumentedExecutor(instr, 20, remoteState);
  const summary = await services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(instr.maxInFlight, 1, "K=1 must never allow more than 1 in-flight attemptWrite");
  assert.equal(summary.results.length, 4);
  for (const result of summary.results) assert.equal(result.status, "SUCCESS");
  for (const videoId of videoIds) assert.equal(instr.attemptCounts.get(videoId), 1, `${videoId} must be attempted exactly once`);
});

test("AC-CONCURRENCY-01 (K=3, real SQLite): real parallel execution, never exceeding 3 in-flight, no duplicate writes, correct per-video audit ordering", async () => {
  const instr: Instrumentation = { maxInFlight: 0, attemptCounts: new Map(), auditLog: [] };
  const changeRegistry = new Map<string, PendingChangeRecord>();
  const remoteState = new Map<string, string>();
  const services = buildServices(changeRegistry, instr, remoteState);
  const videoIds = ["k3-v1", "k3-v2", "k3-v3", "k3-v4", "k3-v5", "k3-v6"];

  const batch = await setUpBatch(services, changeRegistry, videoIds, 3);
  const executor = createInstrumentedExecutor(instr, 30, remoteState);
  const summary = await services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.ok(instr.maxInFlight <= 3, `in-flight count ${instr.maxInFlight} must never exceed the configured K=3`);
  assert.ok(instr.maxInFlight > 1, "K=3 must actually parallelize, not silently degrade to K=1");
  assert.equal(summary.haltedSystemically, false);
  for (const result of summary.results) assert.equal(result.status, "SUCCESS");
  for (const videoId of videoIds) {
    assert.equal(instr.attemptCounts.get(videoId), 1, `${videoId} must be attempted exactly once -- no duplicate write`);
  }

  // Per-video audit ordering: PREPARATION -> ATTEMPT -> RESULT -> VERIFICATION, for
  // every video independently, regardless of how the six videos' events interleave in
  // the shared log (only per-video sequence is required, per §0.B item C).
  for (const videoId of videoIds) {
    const sequence = instr.auditLog.filter((e) => e.videoId === videoId).map((e) => e.eventType);
    assert.deepEqual(sequence, ["PREPARATION", "ATTEMPT", "RESULT", "VERIFICATION"], `audit sequence for ${videoId} out of order: ${sequence.join(",")}`);
  }
});

test("AC-CONCURRENCY-01 + AC-ISOLATION-02 (K=3, real SQLite): a systemic failure halts not-yet-started rows without touching already-completed or in-flight ones", async () => {
  const instr: Instrumentation = { maxInFlight: 0, attemptCounts: new Map(), auditLog: [] };
  const changeRegistry = new Map<string, PendingChangeRecord>();
  const remoteState = new Map<string, string>();
  const services = buildServices(changeRegistry, instr, remoteState);
  // 9 videos, K=3: lane 1 processes v1(systemic)/v4/v7, lane 2 v2/v5/v8, lane 3 v3/v6/v9
  // in cursor order. v1 is systemic and fails immediately (delay 0); v2/v3 (first-round
  // siblings, already in flight or about to start when v1's systemic result lands) get
  // a short delay so they are genuinely in flight when the systemic flag flips; v4.. are
  // long-delayed so they are certain not to have started before the flag flips.
  const videoIds = ["v1-systemic", "v2-inflight", "v3-inflight", "v4-late", "v5-late", "v6-late", "v7-late", "v8-late", "v9-late"];
  const batch = await setUpBatch(services, changeRegistry, videoIds, 3);

  let inFlight = 0;
  const executor: WriteExecutor = {
    async attemptWrite(payload: unknown): Promise<WriteExecutorResult> {
      const videoId = (payload as { videoId: string }).videoId;
      instr.attemptCounts.set(videoId, (instr.attemptCounts.get(videoId) ?? 0) + 1);
      inFlight++;
      instr.maxInFlight = Math.max(instr.maxInFlight, inFlight);

      if (videoId === "v1-systemic") {
        inFlight--;
        return { outcome: "FAILED", detail: "quota exhausted (test fixture)", classification: "permanent", systemic: true };
      }
      if (videoId === "v2-inflight" || videoId === "v3-inflight") {
        // Long enough that v1's systemic result (immediate) is observed by the pool
        // while these two are still in flight -- proving in-flight work is not aborted.
        await new Promise((resolve) => setTimeout(resolve, 60));
        inFlight--;
        remoteState.set(videoId, "New");
        return { outcome: "SUCCESS" };
      }
      // v4..v9: should never actually be dispatched once the systemic flag is set.
      inFlight--;
      remoteState.set(videoId, "New");
      return { outcome: "SUCCESS" };
    },
  };

  const summary = await services.executeBatch({ batchId: batch.id, credentialRef: { userId: "user-1" }, executor });

  assert.equal(summary.haltedSystemically, true);

  const byVideo = new Map(summary.results.map((r) => [r.videoId, r]));
  assert.equal(byVideo.get("v1-systemic")!.status, "FAILED");
  assert.equal(byVideo.get("v1-systemic")!.systemic, true);

  // In-flight siblings dispatched in the same wave as v1 must complete normally --
  // "in-flight work is not interrupted by a systemic result observed elsewhere".
  assert.equal(byVideo.get("v2-inflight")!.status, "SUCCESS", "an in-flight row must retain its own completed result, not be aborted");
  assert.equal(byVideo.get("v3-inflight")!.status, "SUCCESS", "an in-flight row must retain its own completed result, not be aborted");

  // Never-dispatched rows must be ABORTED_SYSTEMIC, and must never have reached attemptWrite.
  for (const videoId of ["v4-late", "v5-late", "v6-late", "v7-late", "v8-late", "v9-late"]) {
    assert.equal(byVideo.get(videoId)!.status, "ABORTED_SYSTEMIC", `${videoId} must be aborted, not attempted, once systemic halt is observed`);
    assert.equal(instr.attemptCounts.get(videoId), undefined, `${videoId} must never have reached attemptWrite`);
  }

  // "Already completed items retain their results" -- re-fetch from the store directly,
  // independent of the in-memory summary, proving persistence, not just the return value.
  const persistedRows = await listStoredLedgerRowsByBatch(batch.id, dbHandle);
  const persistedByVideo = new Map(persistedRows.map((r) => [r.videoId, r]));
  assert.equal(persistedByVideo.get("v2-inflight")!.status, "SUCCESS");
  assert.equal(persistedByVideo.get("v3-inflight")!.status, "SUCCESS");
  assert.equal(persistedByVideo.get("v1-systemic")!.status, "FAILED");
  for (const videoId of ["v4-late", "v5-late", "v6-late", "v7-late", "v8-late", "v9-late"]) {
    assert.equal(persistedByVideo.get(videoId)!.status, "ABORTED_SYSTEMIC");
  }
});

// ---------------------------------------------------------------------------
// AC-CONCURRENCY-03 (docs/acceptance/PHASE_5_ACCEPTANCE.md): two DISTINCT batches (not
// two rows of the same batch, per AC-CONCURRENCY-01/02) that both target the same
// video are never applied concurrently. Deterministic (no reliance on wall-clock
// timing to decide who "wins"): batchA is prepared and its v1 write is put genuinely
// in flight FIRST (its lock is held, its attemptWrite is blocked on a manually-released
// gate); only then is batchB's full executeBatch (its own prepare + attempt) run
// concurrently with batchA's completion, via Promise.all. Real on-disk SQLite, since
// the guarantee under test is enforced by src/lib/db.ts's video_execution_locks table.
// ---------------------------------------------------------------------------

test("AC-CONCURRENCY-03 (real SQLite): two distinct batches targeting the same video are never applied concurrently -- the second is rejected, not raced, while the first's write is genuinely in flight", async () => {
  const instr: Instrumentation = { maxInFlight: 0, attemptCounts: new Map(), auditLog: [] };
  const changeRegistry = new Map<string, PendingChangeRecord>();
  const remoteState = new Map<string, string>();
  const services = buildServices(changeRegistry, instr, remoteState);

  changeRegistry.set("change-a-v1", approvedChange("change-a-v1", "v1"));
  changeRegistry.set("change-b-v1", approvedChange("change-b-v1", "v1"));

  const batchA = await services.createBatch({
    channelId: "UC_TEST",
    concurrency: 1,
    dryRun: false,
    selections: [{ videoId: "v1", changeIds: ["change-a-v1"] }],
  });
  const batchB = await services.createBatch({
    channelId: "UC_TEST",
    concurrency: 1,
    dryRun: false,
    selections: [{ videoId: "v1", changeIds: ["change-b-v1"] }],
  });

  // Gate batchA's attemptWrite so its v1 write is provably still "in flight" (lock held,
  // attempt durably INTENDED, no result yet) at the exact moment batchB is dispatched.
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let batchAWriteStarted = false;
  const executorA: WriteExecutor = {
    async attemptWrite(): Promise<WriteExecutorResult> {
      batchAWriteStarted = true;
      instr.attemptCounts.set("A", (instr.attemptCounts.get("A") ?? 0) + 1);
      await gate; // held open until the test explicitly releases it below.
      remoteState.set("v1", "New");
      return { outcome: "SUCCESS" };
    },
  };
  const executorB: WriteExecutor = {
    async attemptWrite(): Promise<WriteExecutorResult> {
      instr.attemptCounts.set("B", (instr.attemptCounts.get("B") ?? 0) + 1);
      return { outcome: "SUCCESS" };
    },
  };

  const batchAPromise = services.executeBatch({ batchId: batchA.id, credentialRef: { userId: "user-1" }, executor: executorA });

  // Poll (real timers, no fixed sleep guess) until batchA's write has genuinely started
  // and its lock is confirmed held, before dispatching batchB.
  const deadline = Date.now() + 5000;
  while (!batchAWriteStarted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(batchAWriteStarted, "test setup failed: batchA's write never started in time");
  const holderWhileInFlight = await getVideoExecutionLockHolder("v1", dbHandle);
  assert.ok(holderWhileInFlight, "v1 must be locked while batchA's write is in flight");
  assert.equal(holderWhileInFlight!.batchId, batchA.id);

  // Now run batchB concurrently with batchA's still-in-flight completion.
  const batchBPromise = services.executeBatch({ batchId: batchB.id, credentialRef: { userId: "user-1" }, executor: executorB });

  // Give batchB's own prepare/attempt cycle a moment to actually run into the lock
  // conflict (it should resolve near-instantly, unlike batchA which is gated).
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(instr.attemptCounts.get("B"), undefined, "batchB must never reach attemptWrite for v1 while batchA still holds the lock");

  releaseGate!();
  const [summaryA, summaryB] = await Promise.all([batchAPromise, batchBPromise]);

  assert.equal(summaryA.results[0]?.status, "SUCCESS");
  assert.equal(instr.attemptCounts.get("A"), 1, "batchA's v1 must be written exactly once");
  assert.equal(instr.attemptCounts.get("B"), undefined, "batchB must never have written v1 at all -- rejected, not merely delayed past this test's window");

  // batchB's ledger row must be an explicit, clear-reason rejection (video_locked),
  // not a silent no-op and not a crash of the rest of batchB (it only has one row here).
  assert.equal(summaryB.results[0]?.status, "FAILED");
  assert.match(summaryB.results[0]?.detail ?? "", /locked/i);

  // Persistent state, independent of in-memory summaries: v1's final lock is released
  // (batchA finished and released it), and the ledger correctly reflects one SUCCESS
  // (batchA) and one FAILED (batchB) row for the same video, under two different batches.
  const finalHolder = await getVideoExecutionLockHolder("v1", dbHandle);
  assert.equal(finalHolder, null, "v1's lock must be released once batchA's write completes");

  const rowA = await getStoredLedgerRow(
    (await listStoredLedgerRowsByBatch(batchA.id, dbHandle))[0]!.id,
    dbHandle
  );
  const rowB = await getStoredLedgerRow(
    (await listStoredLedgerRowsByBatch(batchB.id, dbHandle))[0]!.id,
    dbHandle
  );
  assert.equal(rowA!.status, "SUCCESS");
  assert.equal(rowB!.status, "FAILED");

  // Complete audit records for both: batchA's full PREPARATION->ATTEMPT->RESULT->
  // VERIFICATION sequence exists, and batchB's own PREPARATION event was recorded even
  // though it never reached an ATTEMPT (its rejection happened during preparation).
  const auditForA = instr.auditLog.filter((e) => e.videoId === "v1");
  assert.ok(auditForA.some((e) => e.eventType === "PREPARATION"), "at least one PREPARATION event must exist for v1");
  assert.ok(auditForA.some((e) => e.eventType === "ATTEMPT"), "batchA's ATTEMPT event must be recorded");
  assert.ok(auditForA.some((e) => e.eventType === "RESULT"), "batchA's RESULT event must be recorded");
  assert.ok(auditForA.some((e) => e.eventType === "VERIFICATION"), "batchA's VERIFICATION event must be recorded");
});
