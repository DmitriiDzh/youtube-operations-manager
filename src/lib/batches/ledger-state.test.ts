// Regression test for docs/TECHNICAL_DEBT.md RISK-10: src/lib/db.ts previously held its
// own hand-maintained copy of LedgerStatus/AttemptPhase/AttemptOutcome, which silently
// fell out of sync with src/lib/batches/contracts.ts's definitions when DRY_RUN_COMPLETE
// (Slice 2) and AWAITING_EXECUTION (Slice 3) were added -- `npm test` alone never caught
// it (it does not typecheck; only `npm run build`'s `tsc` pass did, and only once a test
// happened to pass one of the new literals through a db.ts function signature).
//
// Both files now import from the single canonical src/lib/batches/ledger-state.ts. This
// test asserts two independent things that together close the gap the incident exposed:
//   1. A compile-time check that db.ts's re-exported types and contracts.ts's re-exported
//      types are the exact same type (would fail `tsc`, i.e. `npm run build`, the moment
//      either file stops importing from the shared source).
//   2. A real-SQLite runtime round-trip proving every single literal value of each type
//      can actually be persisted and read back through db.ts's own functions -- the kind
//      of check that would have caught the original incident via `npm test` alone,
//      without waiting for a `tsc` pass.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createClient, type Client } from "@libsql/client";
import {
  beginAttemptIntent,
  channels,
  createBatchWithLedger,
  createIsolatedDb,
  getStoredAttempt,
  getStoredLedgerRow,
  initializeDatabaseSchema,
  recordAttemptResult,
  transitionLedgerRowStatus,
  type AppDb,
  type AttemptOutcome as DbAttemptOutcome,
  type AttemptPhase as DbAttemptPhase,
  type LedgerStatus as DbLedgerStatus,
} from "@/lib/db";
import type {
  AttemptOutcome as ContractsAttemptOutcome,
  AttemptPhase as ContractsAttemptPhase,
  LedgerStatus as ContractsLedgerStatus,
} from "./contracts";
import { ALL_ATTEMPT_OUTCOMES, ALL_ATTEMPT_PHASES, ALL_LEDGER_STATUSES } from "./ledger-state";

// --- 1. Compile-time mutual-assignability check -----------------------------------
type AssertIdentical<A, B> = A extends B ? (B extends A ? true : ["FAIL: B not assignable to A", B]) : ["FAIL: A not assignable to B", A];

// If these two files ever import a different type again, one of the three lines below
// fails to compile (caught by `npm run build`'s `tsc` pass).
const _ledgerStatusIdentical: AssertIdentical<DbLedgerStatus, ContractsLedgerStatus> = true;
const _attemptPhaseIdentical: AssertIdentical<DbAttemptPhase, ContractsAttemptPhase> = true;
const _attemptOutcomeIdentical: AssertIdentical<DbAttemptOutcome, ContractsAttemptOutcome> = true;
void _ledgerStatusIdentical;
void _attemptPhaseIdentical;
void _attemptOutcomeIdentical;

// --- 2. Real-SQLite round-trip for every literal value ----------------------------

let tempDir: string;
let client: Client;
let dbHandle: AppDb;

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "batches-ledger-state-"));
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

test("every LedgerStatus literal round-trips through db.ts persistence unchanged", async () => {
  for (const status of ALL_LEDGER_STATUSES) {
    const batchId = `batch-${status}-${randomUUID()}`;
    const ledgerRowId = `row-${status}-${randomUUID()}`;

    await createBatchWithLedger(
      {
        id: batchId,
        channelId: "UC_TEST",
        concurrency: 1,
        dryRun: false,
        ledgerRows: [{ id: ledgerRowId, videoId: `v-${status}`, changeIds: ["c1"] }],
      },
      dbHandle
    );

    if (status !== "PENDING") {
      const ok = await transitionLedgerRowStatus({ ledgerRowId, from: ["PENDING"], to: status }, dbHandle);
      assert.ok(ok, `db.ts refused to persist LedgerStatus "${status}"`);
    }

    const stored = await getStoredLedgerRow(ledgerRowId, dbHandle);
    assert.ok(stored, `ledger row for status "${status}" was not found after write`);
    assert.equal(stored!.status, status, `LedgerStatus "${status}" did not round-trip correctly`);
  }
});

test("every AttemptPhase/AttemptOutcome literal round-trips through db.ts persistence unchanged", async () => {
  const batchId = `batch-attempts-${randomUUID()}`;
  const ledgerRowId = `row-attempts-${randomUUID()}`;
  await createBatchWithLedger(
    {
      id: batchId,
      channelId: "UC_TEST",
      concurrency: 1,
      dryRun: false,
      ledgerRows: [{ id: ledgerRowId, videoId: "v-attempts", changeIds: ["c1"] }],
    },
    dbHandle
  );

  let attemptNumber = 0;
  for (const outcome of ALL_ATTEMPT_OUTCOMES) {
    attemptNumber++;
    const attemptId = `attempt-${outcome}-${randomUUID()}`;
    const began = await beginAttemptIntent(
      { id: attemptId, ledgerRowId, attemptNumber, payloadSnapshot: { outcome } },
      dbHandle
    );
    assert.ok(began, `db.ts refused to begin an attempt intent (setup for outcome "${outcome}")`);

    const intended = await getStoredAttempt(attemptId, dbHandle);
    assert.ok(intended, `attempt "${attemptId}" not found after beginAttemptIntent`);
    const intendedPhase: DbAttemptPhase = "INTENDED";
    assert.equal(intended!.phase, intendedPhase, `AttemptPhase "INTENDED" did not round-trip correctly`);
    assert.ok(
      (ALL_ATTEMPT_PHASES as readonly string[]).includes(intended!.phase),
      `stored phase "${intended!.phase}" is not one of the canonical ALL_ATTEMPT_PHASES`
    );

    const resolved = await recordAttemptResult({ attemptId, outcome, outcomeDetail: null }, dbHandle);
    assert.ok(resolved, `db.ts refused to record AttemptOutcome "${outcome}"`);

    const result = await getStoredAttempt(attemptId, dbHandle);
    assert.ok(result, `attempt "${attemptId}" not found after recordAttemptResult`);
    assert.equal(result!.outcome, outcome, `AttemptOutcome "${outcome}" did not round-trip correctly`);
    const resultRecordedPhase: DbAttemptPhase = "RESULT_RECORDED";
    assert.equal(result!.phase, resultRecordedPhase, `AttemptPhase "RESULT_RECORDED" did not round-trip correctly`);

    // Free the ledger row's active-attempt slot so the next outcome's beginAttemptIntent
    // in this loop can claim it again (recordAttemptResult already does this internally).
  }
});
