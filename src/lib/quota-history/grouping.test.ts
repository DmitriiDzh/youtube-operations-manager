import assert from "node:assert/strict";
import test from "node:test";
import { groupQuotaCalls, RUN_GAP_SECONDS, type QuotaCallLike } from "./grouping";

const T0 = Date.parse("2026-10-03T18:00:00Z") / 1000;
const call = (offsetSec: number, over: Partial<QuotaCallLike> = {}): QuotaCallLike => ({
  occurredAt: T0 + offsetSec,
  method: "videos.update",
  units: 50,
  outcome: "ok",
  contextKind: "batch",
  contextId: "b1",
  contextLabel: "Batch b1",
  ...over,
});

test("45 videos of one batch run are ONE entry: 45 writes, 45 x 50 = 2250 units, not 45 lines", () => {
  const rows = Array.from({ length: 45 }, (_, i) => call(i * 3));
  const entries = groupQuotaCalls(rows);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].calls, 45);
  assert.equal(entries[0].writeCalls, 45);
  assert.equal(entries[0].units, 2250);
  assert.equal(entries[0].label, "Batch b1");
});

test("a batch resumed after more than the gap is its own entry; exactly the gap still belongs to the same run", () => {
  assert.equal(groupQuotaCalls([call(0), call(RUN_GAP_SECONDS)]).length, 1);
  const split = groupQuotaCalls([call(0), call(RUN_GAP_SECONDS + 1)]);
  assert.equal(split.length, 2);
  assert.ok(Date.parse(split[0].startedAt) > Date.parse(split[1].startedAt), "newest first");
});

test("two different batches that interleave in time stay separate entries", () => {
  const entries = groupQuotaCalls([call(0, { contextId: "b1" }), call(1, { contextId: "b2", contextLabel: "Batch b2" }), call(2, { contextId: "b1" })]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => [e.contextId, e.calls]).sort(), [["b1", 2], ["b2", 1]]);
});

test("units: failed calls count what they were logged with; unknown-cost calls are counted separately, never as 0 hidden", () => {
  const entries = groupQuotaCalls([
    call(0, { method: "videos.list", units: 1 }),
    call(1, { method: "videos.update", units: 1, outcome: "error" }),
    call(2, { method: "videos.update", units: 0, outcome: "quota_exceeded" }),
    call(3, { method: "something.new", units: null }),
  ]);
  assert.equal(entries[0].units, 2);
  assert.equal(entries[0].writeCalls, 0, "only SUCCESSFUL content-changing calls are writes");
  assert.equal(entries[0].failedCalls, 2);
  assert.equal(entries[0].unknownUnitCalls, 1);
});

test("calls with no context are 'other', one entry per quota day, never mixed with a batch", () => {
  const noCtx = { contextKind: null, contextId: null, contextLabel: null } as const;
  const sameDay = groupQuotaCalls([call(0, noCtx), call(60, noCtx), call(120, { method: "videos.list", units: 1 })]);
  assert.equal(sameDay.length, 2);
  const other = sameDay.find((e) => e.kind === "other");
  assert.equal(other?.calls, 2);
  assert.equal(other?.label, "Other API calls");
  // a day later (36 h) is another Pacific day -> another entry even though the gap rule alone would also split it
  assert.equal(groupQuotaCalls([call(0, noCtx), call(36 * 3600, noCtx)]).filter((e) => e.kind === "other").length, 2);
});

test("empty input is an empty history", () => {
  assert.deepEqual(groupQuotaCalls([]), []);
});
