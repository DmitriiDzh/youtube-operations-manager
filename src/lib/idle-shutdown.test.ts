import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_IDLE_SHUTDOWN_TIMEOUT_MS,
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
// same idle window ENDS THE SESSION (onIdle resets Live writes) instead of exiting, once per idle period.

test("resolveIdleAction: exit by default; end-session only for YTOM_SERVICE_MODE=1 (anything else keeps today's exit)", () => {
  assert.equal(resolveIdleAction({}), "exit");
  assert.equal(resolveIdleAction({ YTOM_SERVICE_MODE: "1" }), "end-session");
  for (const other of ["0", "", "true", "yes", "service", " 1"]) assert.equal(resolveIdleAction({ YTOM_SERVICE_MODE: other }), "exit", other);
});

test("service mode: onIdle once per idle period -- not again while nothing new happens, again after new activity goes idle", async () => {
  recordActivity(new Date(Date.now() - 500));
  let calls = 0;
  const stop = startIdleShutdownWatcher({ action: "end-session", timeoutMs: 20, checkIntervalMs: 10, onIdle: () => { calls += 1; } });
  await new Promise((r) => setTimeout(r, 120)); // many checks after the first expiry
  assert.equal(calls, 1, "one session end for one idle period");

  recordActivity(new Date()); // somebody opened the app again: a new session
  await new Promise((r) => setTimeout(r, 120)); // ...which goes idle too
  stop();
  assert.equal(calls, 2, "the new session ends as well -- the watcher never stops by itself in service mode");
});

test("service mode: running work defers the session end exactly like it defers the exit", async () => {
  recordActivity(new Date(Date.now() - 500));
  let busy = true;
  let calls = 0;
  const stop = startIdleShutdownWatcher({ action: "end-session", timeoutMs: 20, checkIntervalMs: 10, isBusy: () => busy, onIdle: () => { calls += 1; } });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls, 0, "no session end while work is running");
  busy = false;
  await new Promise((r) => setTimeout(r, 80));
  stop();
  assert.equal(calls, 1, "the session ends once the work is done");
});

test("default mode is unchanged by BL-158: one onIdle, even when new activity arrives afterwards", async () => {
  recordActivity(new Date(Date.now() - 500));
  let calls = 0;
  const stop = startIdleShutdownWatcher({ timeoutMs: 20, checkIntervalMs: 10, onIdle: () => { calls += 1; } });
  await new Promise((r) => setTimeout(r, 60));
  recordActivity(new Date());
  await new Promise((r) => setTimeout(r, 80));
  stop();
  assert.equal(calls, 1, "the exit sequence starts once; the process is going away");
});
