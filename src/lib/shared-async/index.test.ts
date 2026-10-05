import assert from "node:assert/strict";
import test from "node:test";
import { round2, sleep } from "./index";

// Phase 14 review round 11 (AGENTS.md §M): the one sleep/round2 every media loop and estimate uses.
test("sleep resolves after the delay (an unref'd timer never holds a process open)", async () => {
  const before = Date.now();
  await sleep(15);
  assert.ok(Date.now() - before >= 10);
  await sleep(1, { unref: true });
});

test("round2 rounds half up to two decimals", () => {
  assert.equal(round2(0.04025), 0.04);
  assert.equal(round2(0.0585), 0.06);
  assert.equal(round2(10), 10);
});
