import assert from "node:assert/strict";
import test from "node:test";
import { parseInteger, parseMoney } from "./media-generation-settings";

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

test("parseInteger accepts whole numbers within the range only; empty, decimals and out-of-range are null (never 0)", () => {
  assert.equal(parseInteger("60", { min: 1, max: 1440 }), 60);
  assert.equal(parseInteger(" 15 ", { min: 15, max: 3600 }), 15);
  assert.equal(parseInteger("", { min: 1, max: 10 }), null);
  assert.equal(parseInteger("2.5", { min: 1, max: 10 }), null);
  assert.equal(parseInteger("0", { min: 1, max: 10 }), null);
  assert.equal(parseInteger("1441", { min: 1, max: 1440 }), null);
  assert.equal(parseInteger("-3", { min: 1, max: 10 }), null);
});
