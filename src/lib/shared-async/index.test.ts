import assert from "node:assert/strict";
import test from "node:test";
import { round2 } from "@/lib/shared-money";
import { sleep } from "./index";

// Phase 14 review rounds 11/21 (AGENTS.md §M): the one sleep (shared-async) and round2 (shared-money) the media code uses.
test("sleep resolves after the delay (an unref'd timer never holds a process open)", async () => {
  const before = Date.now();
  await sleep(15);
  assert.ok(Date.now() - before >= 10);
  await sleep(1, { unref: true });
});

// BL-271 (WAIT_TOOLS_PLAN.md AC-WT-07): a wait's sleep ends as soon as the server's stop signal fires, and never throws.
test("sleep with a signal resolves at once when the signal is aborted (already, or while sleeping)", async () => {
  const already = new AbortController();
  already.abort();
  let before = Date.now();
  await sleep(10_000, { signal: already.signal });
  assert.ok(Date.now() - before < 1000, "an aborted signal does not sleep");
  const later = new AbortController();
  before = Date.now();
  setTimeout(() => later.abort(), 20);
  await sleep(10_000, { signal: later.signal });
  const took = Date.now() - before;
  assert.ok(took >= 15 && took < 1000, `woke on abort after ${took} ms`);
});

test("round2 rounds half up to two decimals", () => {
  assert.equal(round2(0.04025), 0.04);
  assert.equal(round2(0.0585), 0.06);
  assert.equal(round2(10), 10);
});
