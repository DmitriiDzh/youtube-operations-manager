import assert from "node:assert/strict";
import test from "node:test";
import { beginBatchExecution, endBatchExecution, isBatchCancelRequested, requestBatchCancelFlag } from "./execution-control";

test("a cancel is accepted only while the batch is executing, and the flag dies with the run", () => {
  assert.equal(requestBatchCancelFlag("b-ctl-1"), false);
  const token = beginBatchExecution("b-ctl-1");
  assert.equal(isBatchCancelRequested("b-ctl-1"), false);
  assert.equal(requestBatchCancelFlag("b-ctl-1"), true);
  assert.equal(isBatchCancelRequested("b-ctl-1"), true);
  endBatchExecution("b-ctl-1", token);
  assert.equal(isBatchCancelRequested("b-ctl-1"), false);
  assert.equal(requestBatchCancelFlag("b-ctl-1"), false);
});

test("a new run starts clean even if a previous run left a flag behind", () => {
  const first = beginBatchExecution("b-ctl-2");
  requestBatchCancelFlag("b-ctl-2");
  endBatchExecution("b-ctl-2", first);
  beginBatchExecution("b-ctl-2");
  assert.equal(isBatchCancelRequested("b-ctl-2"), false);
});

test("a stale run ending does not remove a newer run's entry (token-scoped end)", () => {
  const older = beginBatchExecution("b-ctl-3");
  const newer = beginBatchExecution("b-ctl-3");
  assert.notEqual(older, newer);
  endBatchExecution("b-ctl-3", older); // the older run finishing late
  assert.equal(requestBatchCancelFlag("b-ctl-3"), true, "the newer run is still registered");
  endBatchExecution("b-ctl-3", newer);
  assert.equal(requestBatchCancelFlag("b-ctl-3"), false);
});
