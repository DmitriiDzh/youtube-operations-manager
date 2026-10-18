import assert from "node:assert/strict";
import test from "node:test";
import { CHANNEL_COPY_FRESH_MS, isOwnedChannelCopyFresh } from "./freshness";

// BL-197 (owner, Telegram 2026-10-18, msg 2988): the automatic sync uses the stored copy while it is younger than 6 hours.

const NOW = new Date("2026-10-18T12:00:00Z");

test("channel copy freshness: the window is 6 hours", () => {
  assert.equal(CHANNEL_COPY_FRESH_MS, 21_600_000);
});

// The boundary follows the existing shared rule of refresh-stale ("exactly 6 h is still fresh", its acceptance test; review of BL-197).
test("channel copy freshness: an owned copy synced exactly 6 h ago is fresh; 6 h and 1 s ago is not", () => {
  const owned = (lastSyncedAt: Date) => ({ connectedUserId: "user-1", lastSyncedAt });
  assert.equal(isOwnedChannelCopyFresh({ channel: owned(new Date("2026-10-18T06:00:00Z")), userId: "user-1", now: NOW }), true);
  assert.equal(isOwnedChannelCopyFresh({ channel: owned(new Date("2026-10-18T05:59:59Z")), userId: "user-1", now: NOW }), false);
});

test("channel copy freshness: no row, no owner, another owner or no sync time means the sync runs", () => {
  const recent = new Date("2026-10-18T11:00:00Z");
  assert.equal(isOwnedChannelCopyFresh({ channel: null, userId: "user-1", now: NOW }), false);
  assert.equal(isOwnedChannelCopyFresh({ channel: { connectedUserId: null, lastSyncedAt: recent }, userId: "user-1", now: NOW }), false);
  assert.equal(isOwnedChannelCopyFresh({ channel: { connectedUserId: "user-2", lastSyncedAt: recent }, userId: "user-1", now: NOW }), false);
  assert.equal(isOwnedChannelCopyFresh({ channel: { connectedUserId: "user-1", lastSyncedAt: null }, userId: "user-1", now: NOW }), false);
});

test("channel copy freshness: a sync time in the future (another computer's clock) is not trusted as fresh", () => {
  assert.equal(
    isOwnedChannelCopyFresh({ channel: { connectedUserId: "user-1", lastSyncedAt: new Date("2026-10-18T13:00:00Z") }, userId: "user-1", now: NOW }),
    false
  );
});
