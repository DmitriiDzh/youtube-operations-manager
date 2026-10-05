import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RETRY_CONFIG, computeBackoffDelayMs } from "./contracts";

// Independent test-suite audit (2026-09-26): computeBackoffDelayMs (the §0.E full-jitter
// exponential-backoff formula, a documented, numbered safety parameter meant to avoid
// thundering-herd retries) had zero test coverage anywhere in the repository. Every
// retry-behavior test elsewhere stubs `clock.wait()` as a no-op that discards its argument, so a
// broken formula (no jitter, wrong cap, reversed min/max) would have passed every existing test.
// AC-RETRY-01 (docs/acceptance/PHASE_5_ACCEPTANCE.md) itself requires asserting "a delay within
// the documented jittered range" and to "FAIL if it uses a delay outside the specified range" --
// no test did this before now.
//
// Expected bounds below are independently derived from §0.E's own parameter table (base delay
// 2000ms, ×2 exponential multiplier, 30000ms cap, full jitter = uniform random in
// [0, computedDelay]) -- computed by hand from that documented formula, not copied from running
// the implementation.

function expectedCappedDelay(attemptNumber: number): number {
  const raw = DEFAULT_RETRY_CONFIG.baseDelayMs * Math.pow(DEFAULT_RETRY_CONFIG.backoffMultiplier, attemptNumber - 1);
  return Math.min(raw, DEFAULT_RETRY_CONFIG.maxDelayMs);
}

test("computeBackoffDelayMs: attempt 1 is full-jitter within [0, 2000] (base delay, no backoff growth yet)", () => {
  assert.equal(expectedCappedDelay(1), 2000);
  for (let i = 0; i < 200; i++) {
    const delay = computeBackoffDelayMs(1, DEFAULT_RETRY_CONFIG);
    assert.ok(delay >= 0 && delay <= 2000, `delay ${delay} out of documented [0, 2000] range for attempt 1`);
  }
});

test("computeBackoffDelayMs: attempt 2 doubles to within [0, 4000] (×2 exponential multiplier)", () => {
  assert.equal(expectedCappedDelay(2), 4000);
  for (let i = 0; i < 200; i++) {
    const delay = computeBackoffDelayMs(2, DEFAULT_RETRY_CONFIG);
    assert.ok(delay >= 0 && delay <= 4000, `delay ${delay} out of documented [0, 4000] range for attempt 2`);
  }
});

test("computeBackoffDelayMs: attempt 4 (the last of 4 total attempts per §0.E) is within [0, 16000]", () => {
  assert.equal(expectedCappedDelay(4), 16000);
  for (let i = 0; i < 200; i++) {
    const delay = computeBackoffDelayMs(4, DEFAULT_RETRY_CONFIG);
    assert.ok(delay >= 0 && delay <= 16000, `delay ${delay} out of documented [0, 16000] range for attempt 4`);
  }
});

test("computeBackoffDelayMs: the exponential curve is capped at 30000ms (30s) once uncapped growth would exceed it", () => {
  // Raw (uncapped) delay at attempt 5 would be 2000 * 2^4 = 32000ms, exceeding the documented
  // 30000ms cap -- this is exactly the boundary §0.E's own rationale describes ("capped growth
  // stays <=30s").
  assert.equal(expectedCappedDelay(5), 30000);
  for (let i = 0; i < 200; i++) {
    const delay = computeBackoffDelayMs(5, DEFAULT_RETRY_CONFIG);
    assert.ok(delay >= 0 && delay <= 30000, `delay ${delay} exceeds the documented 30000ms cap at attempt 5`);
  }

  // A far-later attempt number must never exceed the cap either -- the cap is absolute, not a
  // one-time ceiling that could be overshot by a later, larger power-of-two step.
  assert.equal(expectedCappedDelay(10), 30000);
  for (let i = 0; i < 50; i++) {
    const delay = computeBackoffDelayMs(10, DEFAULT_RETRY_CONFIG);
    assert.ok(delay >= 0 && delay <= 30000, `delay ${delay} exceeds the documented 30000ms cap at attempt 10`);
  }
});

test("computeBackoffDelayMs: full jitter actually randomizes -- not a fixed value pretending to be jittered", () => {
  const samples = new Set<number>();
  for (let i = 0; i < 50; i++) {
    samples.add(computeBackoffDelayMs(3, DEFAULT_RETRY_CONFIG));
  }
  // Vanishingly unlikely to collide 50 times in a row under real Math.random() -- a broken
  // implementation that always returns the same value (e.g. the cap itself, or a fixed 0) is
  // exactly the class of regression this guards against.
  assert.ok(samples.size > 1, "expected genuine randomization across repeated calls, got a constant value");
});
