import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_DEVICE_SYNC_STATUS, type DeviceSyncState, type DeviceSyncStatus } from "./contracts";
import { backgroundWriteVerdict } from "./services";

// False divergences (owner, Telegram 2026-10-06, msgs 1758/1764): on 5 October one computer's
// automatic Market Intelligence collection ran while the other computer's fresh collection was
// already waiting for it, so both sides changed data and the bell asked a human. An automatic
// background write may run only once this computer has caught up with the other one. Expected
// verdicts are derived from what each sync state means (ARCHITECTURE.md §23), not from the code.

function status(state: DeviceSyncState, extra: Partial<DeviceSyncStatus> = {}): DeviceSyncStatus {
  return { ...EMPTY_DEVICE_SYNC_STATUS, state, ...extra };
}

test("AC-FD-08: caught up (or no sync at all) -> a background write may run", () => {
  for (const state of ["disabled", "not_configured", "synced", "exported", "imported"] as const) {
    assert.equal(backgroundWriteVerdict(status(state)).allowed, true, state);
  }
});

test("AC-FD-08: waiting only for this computer's own export window -> may run", () => {
  assert.equal(backgroundWriteVerdict(status("waiting", { pendingSince: {} })).allowed, true);
});

test("AC-FD-09: another computer's snapshot still arriving -> wait (the 5 October shape)", () => {
  const verdict = backgroundWriteVerdict(status("waiting", { pendingSince: { "snap-1": 1 } }));
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reason);
});

test("AC-FD-09: an unresolved conflict, a paused sync or an unreachable folder -> wait", () => {
  for (const state of ["attention", "busy", "folder_unreachable"] as const) {
    const verdict = backgroundWriteVerdict(status(state));
    assert.equal(verdict.allowed, false, state);
    assert.ok(verdict.reason, state);
  }
});
