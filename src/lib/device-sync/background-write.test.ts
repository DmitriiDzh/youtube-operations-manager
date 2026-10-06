import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICE_SYNC_TRANSFER_GRACE_MS, EMPTY_DEVICE_SYNC_STATUS, type DeviceSyncState, type DeviceSyncStatus } from "./contracts";
import { backgroundWriteVerdict } from "./services";

// False divergences (owner, Telegram 2026-10-06, msgs 1758/1764): on 5 October one computer's
// automatic Market Intelligence collection ran while the other computer's fresh collection was
// already waiting for it, so both sides changed data and the bell asked a human. An automatic
// background write may run only once this computer has caught up with the other one. Expected
// verdicts are derived from what each sync state means (ARCHITECTURE.md §23), not from the code.
// Review round 1 (#5): a stuck transfer or an unrelated notice must not switch the refresh off for
// good -- those have their own notices; only "something is arriving now" and a real conflict wait.

const NOW = Date.parse("2026-10-06T12:00:00Z");

function status(state: DeviceSyncState, extra: Partial<DeviceSyncStatus> = {}): DeviceSyncStatus {
  return { ...EMPTY_DEVICE_SYNC_STATUS, state, ...extra };
}

const divergence = { kind: "divergence" as const, message: "m", snapshotId: "s" };

test("AC-FD-08: caught up (or no sync at all) -> a background write may run", () => {
  for (const state of ["disabled", "not_configured", "synced", "exported", "imported", "waiting"] as const) {
    assert.equal(backgroundWriteVerdict(status(state), NOW).allowed, true, state);
  }
});

test("AC-FD-08: a snapshot stuck past the grace period (it has its own notice) does not block", () => {
  const stuck = { "snap-old": NOW - DEVICE_SYNC_TRANSFER_GRACE_MS - 1 };
  for (const state of ["waiting", "synced", "attention"] as const) {
    assert.equal(backgroundWriteVerdict(status(state, { pendingSince: stuck }), NOW).allowed, true, state);
  }
});

test("AC-FD-08: an error notice does not block the refresh", () => {
  assert.equal(backgroundWriteVerdict(status("attention", { notices: [{ kind: "error", message: "m" }] }), NOW).allowed, true);
});

test("AC-FD-09: 'update the app' blocks it -- the other computer's newer data is not loaded yet (review round 2, N3)", () => {
  const verdict = backgroundWriteVerdict(status("attention", { notices: [{ kind: "update_app", message: "m" }] }), NOW);
  assert.equal(verdict.allowed, false);
});

test("AC-FD-09: another computer's snapshot arriving right now -> wait, in any state (the 5 October shape)", () => {
  for (const state of ["waiting", "synced", "imported"] as const) {
    const verdict = backgroundWriteVerdict(status(state, { pendingSince: { "snap-1": NOW - 1_000 } }), NOW);
    assert.equal(verdict.allowed, false, state);
  }
});

test("AC-FD-09: an open conflict, a paused sync or an unreachable folder -> wait, with a reason", () => {
  for (const s of [status("attention", { notices: [divergence] }), status("busy"), status("folder_unreachable")]) {
    const verdict = backgroundWriteVerdict(s, NOW);
    assert.equal(verdict.allowed, false, s.state);
    assert.ok(!verdict.allowed && verdict.reason, s.state);
  }
});
