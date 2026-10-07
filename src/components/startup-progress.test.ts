import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_STARTUP, analyticsOutcome, channelUnavailable, reachOutcome, researchOutcome, startupInProgress } from "./startup-progress";

// Owner, Telegram 2026-10-07 (msg 2004): while the app loads its data on open, a loading window says what is being done; it
// goes away once every step has finished (or could not run).

test("the window stays while a step waits or runs, and goes once every step has an outcome", () => {
  assert.equal(startupInProgress(INITIAL_STARTUP), true);
  const done = { state: "done", detail: null } as const;
  assert.equal(startupInProgress({ channel: done, analytics: done, research: { state: "skipped", detail: "x" }, reach: { state: "failed", detail: null } }), false);
  assert.equal(startupInProgress({ channel: done, analytics: done, research: { state: "running", detail: null }, reach: done }), true);
});

test("without the active channel the collections that wait for it are reported as not run, so the window closes", () => {
  const after = channelUnavailable(INITIAL_STARTUP);
  assert.equal(after.channel.state, "failed");
  assert.deepEqual([after.analytics.state, after.research.state, after.reach.state], ["skipped", "skipped", "skipped"]);
  assert.equal(startupInProgress(after), false);
});

test("each collection's answer becomes its line: updated / up to date / skipped with the reason / failed", () => {
  assert.deepEqual(analyticsOutcome(true, { channels: [{ collection: "collected" }] }), { state: "done", detail: "updated; other channels continue in the background" });
  assert.deepEqual(analyticsOutcome(true, { channels: [{ collection: "current" }] }), { state: "done", detail: "up to date" });
  assert.deepEqual(analyticsOutcome(true, { channels: [], inProgress: true }), { state: "done", detail: "already running" });
  // BL-151 AC-AD-06: the other computer's rows made the collection unnecessary.
  assert.deepEqual(analyticsOutcome(true, { channels: [{ collection: "current" }], importedFromPeers: 2 }), { state: "done", detail: "up to date — collected on the other computer" });
  assert.equal(analyticsOutcome(false, null).state, "failed");
  assert.deepEqual(researchOutcome(true, { skipped: true, reason: "the other computer's data is still arriving" }), { state: "skipped", detail: "the other computer's data is still arriving" });
  assert.equal(researchOutcome(true, { collected: 2 }).state, "done");
  assert.equal(researchOutcome(false, null).state, "failed");
  assert.equal(reachOutcome(true).state, "done");
  assert.equal(reachOutcome(false).state, "failed");
});
