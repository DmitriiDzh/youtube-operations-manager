import assert from "node:assert/strict";
import test from "node:test";
import { describeCompleteReason, parseDateDraft, parseDepthDraft } from "./market-collection-depth-fields";

test("parseDepthDraft: blank = not set; a whole number 1..2000 is accepted; everything else is refused", () => {
  assert.deepEqual(parseDepthDraft(""), { ok: true, value: null });
  assert.deepEqual(parseDepthDraft("  "), { ok: true, value: null });
  assert.deepEqual(parseDepthDraft("1"), { ok: true, value: 1 });
  assert.deepEqual(parseDepthDraft(" 2000 "), { ok: true, value: 2000 });
  for (const bad of ["0", "2001", "-3", "1.5", "1e3", "abc", "12 3"]) assert.equal(parseDepthDraft(bad).ok, false, bad);
});

test("parseDateDraft: blank = no date; only a real YYYY-MM-DD date is accepted", () => {
  assert.deepEqual(parseDateDraft(""), { ok: true, value: null });
  assert.deepEqual(parseDateDraft("2026-03-01"), { ok: true, value: "2026-03-01" });
  for (const bad of ["2026-02-30", "03/01/2026", "2026-3-1", "yesterday"]) assert.equal(parseDateDraft(bad).ok, false, bad);
});

test("describeCompleteReason names each reason in plain words", () => {
  assert.equal(describeCompleteReason("cap"), "reached the video limit");
  assert.equal(describeCompleteReason("date"), "reached the earliest publish date");
  assert.equal(describeCompleteReason("exhausted"), "all of the channel's uploads collected");
  assert.equal(describeCompleteReason(null), "");
});
