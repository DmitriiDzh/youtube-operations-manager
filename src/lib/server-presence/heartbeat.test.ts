import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_PRESENCE_STATE, nextPresenceState, PRESENCE_PING_INTERVAL_MS } from "./heartbeat";

test("one failed ping is not 'stopped'; two in a row are", () => {
  const one = nextPresenceState(INITIAL_PRESENCE_STATE, false);
  assert.deepEqual(one, { consecutiveFailures: 1, serverStopped: false });
  assert.deepEqual(nextPresenceState(one, false), { consecutiveFailures: 2, serverStopped: true });
});

test("a success clears the failures, and the stopped verdict (the server was started again)", () => {
  const stopped = nextPresenceState(nextPresenceState(INITIAL_PRESENCE_STATE, false), false);
  assert.equal(stopped.serverStopped, true);
  assert.deepEqual(nextPresenceState(stopped, true), INITIAL_PRESENCE_STATE);
  assert.deepEqual(nextPresenceState(nextPresenceState(INITIAL_PRESENCE_STATE, false), true), INITIAL_PRESENCE_STATE);
});

test("failures separated by a success never add up to 'stopped'", () => {
  let s = INITIAL_PRESENCE_STATE;
  for (const ok of [false, true, false, true, false]) s = nextPresenceState(s, ok);
  assert.equal(s.serverStopped, false);
});

test("the ping interval is one minute, well inside the server's 10-minute idle window", () => {
  assert.equal(PRESENCE_PING_INTERVAL_MS, 60_000);
});
