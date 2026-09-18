// ---------------------------------------------------------------------------
// Real-SQLite integration tests for Slice 1's concurrency guarantees.
//
// Why this file exists in addition to services.test.ts's fake-store tests: the fake
// in-memory store's async functions contain no internal `await` before their
// check-then-write step, so under Node's single-threaded event loop two "concurrent"
// calls against it never actually interleave -- the fake store cannot disprove a race
// condition even if one existed. This file exercises the real guarded SQL
// (UPDATE ... WHERE status = 'PENDING' RETURNING / INSERT ... ON CONFLICT DO NOTHING
// RETURNING) against a real libSQL database with genuine async I/O round-trips, so a
// `Promise.all` of two concurrent calls is a meaningful test of the atomic
// compare-and-set pattern itself (see docs/acceptance/PHASE_5_ACCEPTANCE.md
// AC-CONCURRENCY-01/02/03).
//
// Each racing pair uses TWO SEPARATE libSQL client connections against the SAME on-disk
// database file (not one shared connection) -- this mirrors the real scenario (two
// different requests/processes racing each other).
//
// Connection lifecycle: this environment's native libSQL binding takes several seconds
// to release a Windows file handle on `client.close()` (confirmed by direct measurement
// during development of this file -- a fresh, single-process, non-`node:test` script
// completes the exact same sequence of operations in under 100ms end-to-end, while
// opening and closing that many client connections once per test under `node --test`
// pushed total suite time past a 60s per-file timeout). This is an environment/tooling
// characteristic of closing a local SQLite connection here, not a defect in the
// application logic under test -- the logic itself was independently verified to be
// correct and fast via the standalone script. To avoid that overhead multiplying across
// tests, this file opens its two connections ONCE in `before` and closes them ONCE in
// `after`, with each test using distinct video/batch ids so tests cannot interfere with
// each other despite sharing connections.
//
// Limitation (documented honestly, not silently assumed away): this proves the SQL
// pattern is a correct atomic compare-and-set across two connections to one local file in
// one OS process. It does not simulate two separate OS processes / machines contending
// for the same file over a network (this project's SQLite file is always local-only, per
// docs/PROJECT_SPEC.md §37, so that scenario does not apply here). Slice 5's independent
// review should note this boundary.
//
// Per docs/DEVELOPMENT_PLAYBOOK.md §6.11: the database here is a fresh temp file under
// os.tmpdir(), created and destroyed within this file. data/playlist-manager.db (the
// operator's real local state) is never opened, imported, or referenced by this file.
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
  getStoredBatch,
  getStoredLedgerRow,
  getVideoExecutionLockHolder,
  initializeDatabaseSchema,
  listStoredAttemptsByLedgerRow,
  recordAttemptResult,
  releaseVideoExecutionLock,
  type AppDb,
} from "@/lib/db";

let tempDir: string;
let clientA: Client;
let clientB: Client;
let dbA: AppDb;
let dbB: AppDb;

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "batches-concurrency-"));
  const dbFilePath = path.join(tempDir, "test.db");

  clientA = createClient({ url: `file:${dbFilePath}` });
  await initializeDatabaseSchema(clientA);
  dbA = createIsolatedDb(clientA);

  // batches.channel_id has a FOREIGN KEY REFERENCES channels(id), and this libSQL build
  // enforces it -- a valid parent row is required before any batch can be inserted.
  await dbA.insert(channels).values({
    id: "UC_TEST",
    title: "Test Channel",
    thumbnailUrl: null,
    uploadsPlaylistId: "UU_TEST",
    connectedUserId: null,
  });

  clientB = createClient({ url: `file:${dbFilePath}` });
  // See the comment in initializeDatabaseSchema (src/lib/db.ts) -- clientA gets this
  // pragma from that call, but clientB never calls initializeDatabaseSchema itself.
  await clientB.execute("PRAGMA busy_timeout = 5000");
  await clientB.execute("PRAGMA journal_mode = WAL");
  dbB = createIsolatedDb(clientB);
});

after(async () => {
  clientA.close();
  clientB.close();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("schema initialization is idempotent against an already-initialized isolated database (§6.11)", async () => {
  await assert.doesNotReject(() => initializeDatabaseSchema(clientA));

  const batchId = randomUUID();
  await createBatchWithLedger(
    {
      id: batchId,
      channelId: "UC_TEST",
      concurrency: 1,
      dryRun: true,
      ledgerRows: [{ id: randomUUID(), videoId: "v-schema-check", changeIds: ["c1"] }],
    },
    dbA
  );

  const batch = await getStoredBatch(batchId, dbA);
  assert.equal(batch?.status, "PENDING");
});

test("AC-CONCURRENCY-02/03 (real SQLite): concurrent claims for the same batch -- exactly one succeeds", async () => {
  const batchId = randomUUID();
  await createBatchWithLedger(
    {
      id: batchId,
      channelId: "UC_TEST",
      concurrency: 1,
      dryRun: true,
      ledgerRows: [{ id: randomUUID(), videoId: "v-claim-race", changeIds: ["c1"] }],
    },
    dbA
  );

  const [claimA, claimB] = await Promise.all([
    claimBatchExecution(batchId, "run-A", dbA),
    claimBatchExecution(batchId, "run-B", dbB),
  ]);

  // Exactly one of the two concurrent claims (issued over two separate connections)
  // may have succeeded -- never both, never neither.
  assert.equal([claimA, claimB].filter(Boolean).length, 1);

  const batch = await getStoredBatch(batchId, dbA);
  assert.equal(batch?.status, "RUNNING");
  assert.ok(batch?.runId === "run-A" || batch?.runId === "run-B");
});

test("AC-CONCURRENCY-01 (real SQLite): concurrent lock acquisition for the same video by two batches -- exactly one succeeds", async () => {
  const batchA = randomUUID();
  const batchB = randomUUID();
  const rowA = randomUUID();
  const rowB = randomUUID();
  const videoId = "v-lock-race";

  await createBatchWithLedger(
    {
      id: batchA,
      channelId: "UC_TEST",
      concurrency: 1,
      dryRun: true,
      ledgerRows: [{ id: rowA, videoId, changeIds: ["c1"] }],
    },
    dbA
  );
  await createBatchWithLedger(
    {
      id: batchB,
      channelId: "UC_TEST",
      concurrency: 1,
      dryRun: true,
      ledgerRows: [{ id: rowB, videoId, changeIds: ["c2"] }],
    },
    dbA
  );

  const [lockA, lockB] = await Promise.all([
    acquireVideoExecutionLock({ videoId, batchId: batchA, ledgerRowId: rowA }, dbA),
    acquireVideoExecutionLock({ videoId, batchId: batchB, ledgerRowId: rowB }, dbB),
  ]);

  assert.equal([lockA, lockB].filter(Boolean).length, 1);

  const winner = lockA ? batchA : batchB;
  const holder = await getVideoExecutionLockHolder(videoId, dbA);
  assert.equal(holder?.batchId, winner);

  await releaseVideoExecutionLock({ videoId, batchId: winner }, dbA);
  assert.equal(await getVideoExecutionLockHolder(videoId, dbA), null);

  // Now the loser can acquire it, proving release actually frees the lock rather than
  // merely reporting success.
  const loser = winner === batchA ? batchB : batchA;
  const loserRow = winner === batchA ? rowB : rowA;
  const acquiredAfterRelease = await acquireVideoExecutionLock(
    { videoId, batchId: loser, ledgerRowId: loserRow },
    dbA
  );
  assert.equal(acquiredAfterRelease, true);
});

test("Attempt concurrency (real SQLite, two connections): at most one active attempt per ledger row, never both", async () => {
  const batchId = randomUUID();
  const rowId = randomUUID();
  const videoId = "v-attempt-race";

  await createBatchWithLedger(
    {
      id: batchId,
      channelId: "UC_TEST",
      concurrency: 1,
      dryRun: true,
      ledgerRows: [{ id: rowId, videoId, changeIds: ["c1"] }],
    },
    dbA
  );

  const attemptIdA = randomUUID();
  const attemptIdB = randomUUID();

  // Both racers compute the SAME attemptNumber from a (stale, pre-race) read -- exactly
  // the scenario a count()-then-insert approach would get wrong. beginAttemptIntent's
  // atomic claim-then-insert must let only one of them actually write an attempt row,
  // regardless of what number either one computed.
  const [claimedA, claimedB] = await Promise.all([
    beginAttemptIntent({ id: attemptIdA, ledgerRowId: rowId, attemptNumber: 1, payloadSnapshot: { from: "A" } }, dbA),
    beginAttemptIntent({ id: attemptIdB, ledgerRowId: rowId, attemptNumber: 1, payloadSnapshot: { from: "B" } }, dbB),
  ]);

  assert.equal([claimedA, claimedB].filter(Boolean).length, 1);

  const attempts = await listStoredAttemptsByLedgerRow(rowId, dbA);
  assert.equal(attempts.length, 1);

  const row = await getStoredLedgerRow(rowId, dbA);
  const winnerAttemptId = claimedA ? attemptIdA : attemptIdB;
  assert.equal(row?.activeAttemptId, winnerAttemptId);

  // While the winning attempt is still unresolved, a third attempt must also be refused.
  const attemptIdC = randomUUID();
  const claimedC = await beginAttemptIntent(
    { id: attemptIdC, ledgerRowId: rowId, attemptNumber: 2, payloadSnapshot: { from: "C" } },
    dbA
  );
  assert.equal(claimedC, false);

  // Resolving the active attempt frees the slot -- a new attempt is then accepted.
  await recordAttemptResult({ attemptId: winnerAttemptId, outcome: "FAILED", outcomeDetail: "503" }, dbA);
  const rowAfterResolution = await getStoredLedgerRow(rowId, dbA);
  assert.equal(rowAfterResolution?.activeAttemptId, null);

  const attemptIdD = randomUUID();
  const claimedD = await beginAttemptIntent(
    { id: attemptIdD, ledgerRowId: rowId, attemptNumber: 2, payloadSnapshot: { from: "D" } },
    dbA
  );
  assert.equal(claimedD, true);

  const finalAttempts = await listStoredAttemptsByLedgerRow(rowId, dbA);
  assert.equal(finalAttempts.length, 2);
});
