import assert from "node:assert/strict";
import test from "node:test";
import { parseMoney } from "./media-generation-settings";

// Review round 11 (standing rule: no locale-dependent native number widgets for settings): the money fields are
// controlled text inputs; both decimal separators parse, a cleared or non-positive field is null (never 0).
test("parseMoney accepts '2.5' and '2,5', rejects empty, text, zero and negatives", () => {
  assert.equal(parseMoney("2.5"), 2.5);
  assert.equal(parseMoney(" 2,5 "), 2.5);
  assert.equal(parseMoney("10"), 10);
  assert.equal(parseMoney(""), null);
  assert.equal(parseMoney("abc"), null);
  assert.equal(parseMoney("0"), null);
  assert.equal(parseMoney("-1"), null);
  assert.equal(parseMoney("1.2.3"), null);
});
