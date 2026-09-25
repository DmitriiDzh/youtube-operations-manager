import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS,
  getLastActivityAt,
  isIdleTimeoutExceeded,
  recordActivity,
  startIdleShutdownWatcher,
} from "./idle-shutdown";

test("isIdleTimeoutExceeded: false before the timeout, true once it is reached or passed", () => {
  const lastActivityAt = new Date("2026-09-25T12:00:00Z").getTime();
  const timeoutMs = 5 * 60 * 1000;

  assert.equal(
    isIdleTimeoutExceeded({ lastActivityAt, now: new Date("2026-09-25T12:04:59Z"), timeoutMs }),
    false
  );
  assert.equal(
    isIdleTimeoutExceeded({ lastActivityAt, now: new Date("2026-09-25T12:05:00Z"), timeoutMs }),
    true,
    "exactly at the boundary must already count as idle, not require strictly exceeding it"
  );
  assert.equal(
    isIdleTimeoutExceeded({ lastActivityAt, now: new Date("2026-09-25T12:10:00Z"), timeoutMs }),
    true
  );
});

test("isIdleTimeoutExceeded: never true for a lastActivityAt in the future (clock-skew guard)", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  const lastActivityAt = new Date("2026-09-25T12:05:00Z").getTime();

  assert.equal(isIdleTimeoutExceeded({ lastActivityAt, now, timeoutMs: 5 * 60 * 1000 }), false);
});

test("recordActivity/getLastActivityAt: reflects the timestamp of the most recent call", () => {
  recordActivity(new Date("2026-09-25T12:00:00Z"));
  assert.equal(getLastActivityAt(), new Date("2026-09-25T12:00:00Z").getTime());

  recordActivity(new Date("2026-09-25T12:00:07Z"));
  assert.equal(getLastActivityAt(), new Date("2026-09-25T12:00:07Z").getTime());
});

test("recordActivity: defaults to the real current time when called with no argument", () => {
  const before = Date.now();
  recordActivity();
  const after = Date.now();

  assert.ok(getLastActivityAt() >= before && getLastActivityAt() <= after);
});

test("DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS is exactly 5 minutes (owner instruction, 2026-09-25)", () => {
  assert.equal(DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS, 5 * 60 * 1000);
});

test("startIdleShutdownWatcher: calls onIdle once the recorded activity is stale enough, and stops checking once cancelled", async () => {
  recordActivity(new Date());
  let idleCalls = 0;

  // A short timeout/check interval so this test doesn't actually wait 5 real minutes -- the
  // watcher's own logic is timeout-agnostic (it just compares `now - lastActivityAt`), so a
  // small injected value exercises the exact same code path as the real 5-minute default.
  recordActivity(new Date(Date.now() - 50));
  const stop = startIdleShutdownWatcher({
    timeoutMs: 20,
    checkIntervalMs: 10,
    onIdle: () => {
      idleCalls += 1;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  const callsAtStop = idleCalls;

  assert.ok(callsAtStop >= 1, "onIdle must have fired at least once while idle");

  // Recording fresh activity, then waiting past another check interval, must not trigger a
  // further call once the watcher has been stopped.
  recordActivity(new Date());
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(idleCalls, callsAtStop, "a stopped watcher must never call onIdle again");
});
