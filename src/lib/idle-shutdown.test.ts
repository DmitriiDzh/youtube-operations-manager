import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS,
  createIdleHandler,
  decideIdleShutdown,
  resolveIdleAction,
  resolveIdleTimeoutMs,
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

test("DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS is exactly 10 minutes (owner instruction 2026-10-03, BL-116: presence heartbeat replaces the 60-minute window)", () => {
  assert.equal(DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS, 10 * 60 * 1000);
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

// ---- BL-116: presence-based shutdown that never cuts running work short ----

const T = 10 * 60_000;
const LAST = Date.parse("2026-10-03T12:00:00Z");
const at = (ms: number) => new Date(LAST + ms);

test("decideIdleShutdown: stay inside the window, exit exactly at the timeout when nothing is running", () => {
  assert.equal(decideIdleShutdown({ lastActivityAt: LAST, now: at(T - 1), timeoutMs: T, busy: false }), "stay");
  assert.equal(decideIdleShutdown({ lastActivityAt: LAST, now: at(T), timeoutMs: T, busy: false }), "exit");
  assert.equal(decideIdleShutdown({ lastActivityAt: LAST, now: at(T - 1), timeoutMs: T, busy: true }), "stay", "busy never matters before the window ends");
});

test("decideIdleShutdown: running work defers an expired window, and exits anyway 2 hours after the window expired", () => {
  const twoHours = 2 * 60 * 60_000;
  assert.equal(decideIdleShutdown({ lastActivityAt: LAST, now: at(T), timeoutMs: T, busy: true }), "defer");
  assert.equal(decideIdleShutdown({ lastActivityAt: LAST, now: at(T + twoHours - 1), timeoutMs: T, busy: true }), "defer");
  assert.equal(decideIdleShutdown({ lastActivityAt: LAST, now: at(T + twoHours), timeoutMs: T, busy: true }), "exit");
});

test("decideIdleShutdown: work that ends later lets the next check exit", () => {
  assert.equal(decideIdleShutdown({ lastActivityAt: LAST, now: at(T + 5 * 60_000), timeoutMs: T, busy: true }), "defer");
  assert.equal(decideIdleShutdown({ lastActivityAt: LAST, now: at(T + 6 * 60_000), timeoutMs: T, busy: false }), "exit");
});

test("resolveIdleTimeoutMs: default 10 minutes; a positive number of minutes (fractions allowed) overrides; garbage falls back", () => {
  assert.equal(resolveIdleTimeoutMs({}), 600_000);
  assert.equal(resolveIdleTimeoutMs({ YTOM_IDLE_SHUTDOWN_MINUTES: "0.5" }), 30_000);
  assert.equal(resolveIdleTimeoutMs({ YTOM_IDLE_SHUTDOWN_MINUTES: "30" }), 1_800_000);
  for (const bad of ["0", "-3", "abc", ""]) assert.equal(resolveIdleTimeoutMs({ YTOM_IDLE_SHUTDOWN_MINUTES: bad }), 600_000, bad);
});

test("startIdleShutdownWatcher: does not call onIdle while isBusy is true, calls it once the work ends; a throwing isBusy counts as busy", async () => {
  recordActivity(new Date(Date.now() - 500));
  let busy = true;
  let idleCalls = 0;
  const stop = startIdleShutdownWatcher({ timeoutMs: 20, checkIntervalMs: 10, isBusy: () => busy, onIdle: () => { idleCalls += 1; } });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(idleCalls, 0, "deferred while busy");
  busy = false;
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(idleCalls >= 1, "exits once the work ended");
  stop();

  recordActivity(new Date(Date.now() - 500));
  let throwingCalls = 0;
  const stop2 = startIdleShutdownWatcher({
    timeoutMs: 20,
    checkIntervalMs: 10,
    isBusy: () => {
      throw new Error("cannot tell");
    },
    onIdle: () => { throwingCalls += 1; },
  });
  await new Promise((r) => setTimeout(r, 80));
  stop2();
  assert.equal(throwingCalls, 0, "an unknown state never cuts work short");
});

test("the last-activity timestamp lives on globalThis, so the proxy's, a route's and the watcher's separately bundled copies of this module share it", () => {
  const stamp = new Date("2026-10-03T12:34:56Z");
  recordActivity(stamp);
  const shared = (globalThis as Record<symbol, unknown>)[Symbol.for("ytom.idleShutdown.lastActivityAt")];
  assert.equal(shared, stamp.getTime());
});

test("startIdleShutdownWatcher: onIdle runs once even when the exit sequence outlasts several check intervals", async () => {
  recordActivity(new Date(Date.now() - 500));
  let calls = 0;
  const stop = startIdleShutdownWatcher({ timeoutMs: 20, checkIntervalMs: 10, onIdle: () => { calls += 1; } });
  await new Promise((r) => setTimeout(r, 120)); // many intervals after the first expiry
  stop();
  assert.equal(calls, 1);
});

// ---- BL-158: the macOS system service (owner, Telegram 2026-10-08, msgs 2150-2154) ----
// Requirement: started at Mac power-on for the second Mac account too, the server is never stopped by idleness.
// Gate B rule (docs/TECHNICAL_DEBT.md RISK-09): Live writes live only as long as a session -- so in service mode the
// same idle window ENDS THE SESSION (Live writes reset) instead of exiting, once per idle period.

// Waits for a condition instead of a fixed sleep, so a loaded machine cannot make these tests flaky (BL-156).
async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return condition();
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("resolveIdleAction: exit by default; end-session only for YTOM_SERVICE_MODE=1 (anything else keeps today's exit)", () => {
  assert.equal(resolveIdleAction({}), "exit");
  assert.equal(resolveIdleAction({ YTOM_SERVICE_MODE: "1" }), "end-session");
  for (const other of ["0", "", "true", "yes", "service", " 1"]) assert.equal(resolveIdleAction({ YTOM_SERVICE_MODE: other }), "exit", other);
});

test("service mode: onIdle once per idle period -- not again while nothing new happens, again after new activity goes idle", async () => {
  recordActivity(new Date(Date.now() - 500));
  let calls = 0;
  const stop = startIdleShutdownWatcher({ action: "end-session", timeoutMs: 20, checkIntervalMs: 10, onIdle: () => { calls += 1; } });
  try {
    assert.ok(await waitFor(() => calls >= 1), "the first idle period ends the session");
    await pause(100); // many more checks with no new activity
    assert.equal(calls, 1, "one session end for one idle period");

    recordActivity(new Date()); // somebody opened the app again: a new session
    assert.ok(await waitFor(() => calls >= 2), "the new session ends as well -- the watcher never stops by itself in service mode");
    await pause(100);
    assert.equal(calls, 2);
  } finally {
    stop();
  }
});

test("service mode: running work defers the session end exactly like it defers the exit", async () => {
  recordActivity(new Date(Date.now() - 500));
  let busy = true;
  let calls = 0;
  const stop = startIdleShutdownWatcher({ action: "end-session", timeoutMs: 20, checkIntervalMs: 10, isBusy: () => busy, onIdle: () => { calls += 1; } });
  try {
    await pause(100);
    assert.equal(calls, 0, "no session end while work is running");
    busy = false;
    assert.ok(await waitFor(() => calls >= 1), "the session ends once the work is done");
    await pause(100);
    assert.equal(calls, 1);
  } finally {
    stop();
  }
});

test("service mode: work still running at the deferral cap ends the session once, then nothing until new activity", async () => {
  recordActivity(new Date(Date.now() - 500)); // the window (20 ms) and the cap (50 ms after it) are both long past
  let calls = 0;
  const stop = startIdleShutdownWatcher({ action: "end-session", timeoutMs: 20, maxDeferralMs: 50, checkIntervalMs: 10, isBusy: () => true, onIdle: () => { calls += 1; } });
  try {
    assert.ok(await waitFor(() => calls >= 1), "the cap applies in service mode too");
    await pause(100);
    assert.equal(calls, 1, "still busy, but the same idle period is not ended twice");
  } finally {
    stop();
  }
});

test("default mode is unchanged by BL-158: one onIdle, even when new activity arrives afterwards", async () => {
  recordActivity(new Date(Date.now() - 500));
  let calls = 0;
  const stop = startIdleShutdownWatcher({ timeoutMs: 20, checkIntervalMs: 10, onIdle: () => { calls += 1; } });
  try {
    assert.ok(await waitFor(() => calls >= 1));
    recordActivity(new Date());
    await pause(100);
    assert.equal(calls, 1, "the exit sequence starts once; the process is going away");
  } finally {
    stop();
  }
});

test("activity that arrives while the busy check runs is not overruled by the stale timestamp", async () => {
  recordActivity(new Date(Date.now() - 500));
  let returnedAt = 0;
  const endedAt: number[] = [];
  const stop = startIdleShutdownWatcher({
    action: "end-session",
    timeoutMs: 20,
    checkIntervalMs: 10,
    isBusy: async () => {
      if (returnedAt === 0) {
        returnedAt = Date.now(); // the user comes back during the first check
        recordActivity(new Date(returnedAt));
      }
      return false;
    },
    onIdle: () => { endedAt.push(Date.now()); },
  });
  try {
    assert.ok(await waitFor(() => endedAt.length >= 1));
    assert.ok(endedAt[0] - returnedAt >= 20, "the returning user's session ends only after its own idle window, not on the old timestamp");
  } finally {
    stop();
  }
});

// The handler itself (what instrumentation.ts runs on an expired window).
function recordingSteps(options: { failStopPods?: boolean; failReset?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    steps: {
      resetLiveWrites: async () => { calls.push("resetLiveWrites"); if (options.failReset) throw new Error("SQLITE_BUSY"); },
      stopPods: async () => { calls.push("stopPods"); if (options.failStopPods) throw new Error("RunPod unreachable"); },
      flush: async () => { calls.push("flush"); },
      exit: () => { calls.push("exit"); },
      onSessionEnded: () => { calls.push("sessionEnded"); },
      onSessionEndFailed: () => { calls.push("sessionEndFailed"); },
    },
  };
}

test("createIdleHandler end-session: switches Live writes off and reports it -- never stops pods, flushes or exits", async () => {
  const { calls, steps } = recordingSteps();
  assert.equal(await createIdleHandler("end-session", steps)(), true);
  assert.deepEqual(calls, ["resetLiveWrites", "sessionEnded"]);
});

test("createIdleHandler end-session: a failed reset is reported as a failure, never as a session end (so it is retried)", async () => {
  const { calls, steps } = recordingSteps({ failReset: true });
  assert.equal(await createIdleHandler("end-session", steps)(), false);
  assert.deepEqual(calls, ["resetLiveWrites", "sessionEndFailed"]);
});

test("createIdleHandler exit: a failed reset does not hold up the exit (the lease lapses on its own once the process is gone)", async () => {
  const { calls, steps } = recordingSteps({ failReset: true });
  await createIdleHandler("exit", steps)();
  assert.deepEqual(calls, ["resetLiveWrites", "stopPods", "flush", "exit"]);
});

test("service mode: a session end that failed is tried again on a later check, and not again once it succeeded", async () => {
  recordActivity(new Date(Date.now() - 500));
  let attempts = 0;
  const stop = startIdleShutdownWatcher({
    action: "end-session",
    timeoutMs: 20,
    checkIntervalMs: 10,
    onIdle: async () => {
      attempts += 1;
      return attempts >= 2; // the first reset fails, the second works
    },
  });
  try {
    assert.ok(await waitFor(() => attempts >= 2), "the failed session end is retried");
    await pause(100);
    assert.equal(attempts, 2, "once it worked, the same idle period is not ended again");
  } finally {
    stop();
  }
});

test("createIdleHandler exit: Live writes off, pods stopped, changes published, then exit -- in that order", async () => {
  const { calls, steps } = recordingSteps();
  await createIdleHandler("exit", steps)();
  assert.deepEqual(calls, ["resetLiveWrites", "stopPods", "flush", "exit"]);
});

test("createIdleHandler exit: the process still exits when stopping the pods fails", async () => {
  const { calls, steps } = recordingSteps({ failStopPods: true });
  await createIdleHandler("exit", steps)().catch(() => undefined);
  assert.deepEqual(calls, ["resetLiveWrites", "stopPods", "exit"]);
});
