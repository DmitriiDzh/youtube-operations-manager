import assert from "node:assert/strict";
import test from "node:test";
import { deriveBatchStage, ledgerRowToItem, summarizeBatchRows, type ProgressLedgerRow } from "./batch-progress";

const row = (status: string, error: string | null = null): ProgressLedgerRow => ({ id: `r-${status}`, videoId: `v-${status}`, status, error });

// Expected values come from the ledger state machine documented in src/lib/batches/contracts.ts
// (PENDING/AWAITING_EXECUTION not started, APPLYING in flight, the rest terminal or UNKNOWN), never
// from running ledgerRowToItem and copying its output.

test("not-started states are pending, an in-flight attempt is running", () => {
  assert.equal(ledgerRowToItem(row("PENDING")).status, "pending");
  assert.equal(ledgerRowToItem(row("AWAITING_EXECUTION")).status, "pending");
  assert.equal(ledgerRowToItem(row("APPLYING")).status, "running");
});

test("SUCCESS and DRY_RUN_COMPLETE finish OK", () => {
  assert.equal(ledgerRowToItem(row("SUCCESS")).status, "done");
  assert.equal(ledgerRowToItem(row("DRY_RUN_COMPLETE")).status, "done");
});

test("FAILED, CONFLICT and ABORTED_SYSTEMIC are failed, with the error text or the status name as detail", () => {
  assert.deepEqual(
    { s: ledgerRowToItem(row("FAILED", "boom")).status, d: ledgerRowToItem(row("FAILED", "boom")).detail },
    { s: "failed", d: "boom" }
  );
  assert.equal(ledgerRowToItem(row("CONFLICT")).detail, "CONFLICT");
  assert.equal(ledgerRowToItem(row("ABORTED_SYSTEMIC")).status, "failed");
});

test("UNKNOWN (sent write, unconfirmed) is never shown as written", () => {
  const item = ledgerRowToItem(row("UNKNOWN"));
  assert.equal(item.status, "failed");
  assert.match(item.detail ?? "", /not confirmed/);
});

test("item id is the ledger row id and the label is the video id", () => {
  const item = ledgerRowToItem({ id: "L1", videoId: "VID", status: "PENDING", error: null });
  assert.equal(item.id, "L1");
  assert.equal(item.label, "VID");
});

test("stage: dry-run is explicit that nothing is written; live shows preparing, then writing", () => {
  assert.match(deriveBatchStage([row("PENDING")], true), /nothing is written/);
  assert.match(deriveBatchStage([row("PENDING"), row("AWAITING_EXECUTION")], false), /Preparing/);
  assert.match(deriveBatchStage([row("AWAITING_EXECUTION"), row("APPLYING")], false), /Writing/);
  assert.match(deriveBatchStage([row("AWAITING_EXECUTION")], false), /Writing/);
});

test("summary: 2 written, 1 failed, 1 waiting", () => {
  assert.equal(
    summarizeBatchRows([row("SUCCESS"), row("SUCCESS"), row("FAILED"), row("PENDING")], false),
    "2 written, 1 not written (see the batch table), 1 still waiting."
  );
  assert.equal(summarizeBatchRows([row("DRY_RUN_COMPLETE")], true), "1 checked.");
});
