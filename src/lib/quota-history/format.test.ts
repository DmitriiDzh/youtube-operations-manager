import assert from "node:assert/strict";
import test from "node:test";
import { formatTimeUntil } from "./format";

test("formatTimeUntil", () => {
  assert.equal(formatTimeUntil(-5), "now");
  assert.equal(formatTimeUntil(0), "now");
  assert.equal(formatTimeUntil(59_999), "less than a minute");
  assert.equal(formatTimeUntil(60_000), "1 min");
  assert.equal(formatTimeUntil(45 * 60_000), "45 min");
  assert.equal(formatTimeUntil(3 * 3_600_000 + 12 * 60_000 + 30_000), "3 h 12 min");
  assert.equal(formatTimeUntil(25 * 3_600_000), "25 h 0 min");
});
