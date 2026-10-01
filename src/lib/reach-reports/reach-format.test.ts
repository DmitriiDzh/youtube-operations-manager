import assert from "node:assert/strict";
import test from "node:test";
import { formatCtr, formatImpressions } from "./reach-format";

test("formatCtr renders a ratio as a percentage with 2 decimals, and an unknown CTR as an em dash (never 0%)", () => {
  assert.equal(formatCtr(0.052), "5.20%");
  assert.equal(formatCtr(0.02), "2.00%");
  assert.equal(formatCtr(0), "0.00%");
  assert.equal(formatCtr(null), "—");
});

test("formatImpressions groups thousands", () => {
  assert.equal(formatImpressions(1234567), "1,234,567");
  assert.equal(formatImpressions(0), "0");
});
