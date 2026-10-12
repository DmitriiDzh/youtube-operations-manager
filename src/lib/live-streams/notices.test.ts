import assert from "node:assert/strict";
import test from "node:test";
import { encoderDownSince, liveNotices, type StreamNoticeInput } from "./notices";

// BL-176 acceptance, LIVE_STREAMS_PLAN.md §4.1 "Alert": with the down threshold at 5 min, down at 10:00:00 -> no notice at
// 10:04:59, a notice at 10:05:00. §3.10: the encoder OR YouTube not live; YouTube ending the broadcast; no next video.

const T = (hms: string) => Date.parse(`2026-10-12T${hms}Z`);
const base: StreamNoticeInput = { channelId: "UC1", intent: "on", onSince: T("09:00:00"), helper: null, youtube: null, endedAt: null };

test("alert: down at 10:00:00 -> no notice at 10:04:59, a notice at 10:05:00 (threshold 5 min)", () => {
  const s: StreamNoticeInput = { ...base, helper: { state: "restarting", updatedAt: T("10:04:58"), lastExitAt: T("10:00:00"), missingVideoId: null } };
  assert.deepEqual(liveNotices([s], T("10:04:59"), 5), []);
  assert.deepEqual(liveNotices([s], T("10:05:00"), 5), [{ channelId: "UC1", kind: "live_stream_down", since: T("10:00:00") }]);
});

test("alert: YouTube not live counts too, from the earlier of the two", () => {
  const s: StreamNoticeInput = {
    ...base,
    helper: { state: "running", updatedAt: T("10:09:58"), lastExitAt: null, missingVideoId: null },
    youtube: { checkedAt: T("10:09:00"), lifeCycleStatus: "ready", notLiveSince: T("10:02:00") },
  };
  assert.deepEqual(liveNotices([s], T("10:06:59"), 5), []);
  assert.deepEqual(liveNotices([s], T("10:07:00"), 5).map((n) => n.kind), ["live_stream_down"]);
});

test("a running or replaying encoder with a fresh status is not down; a stale status is down since it was written", () => {
  const now = T("10:10:00");
  assert.equal(encoderDownSince({ ...base, helper: { state: "running", updatedAt: T("10:09:55"), lastExitAt: null, missingVideoId: null } }, now), null);
  assert.equal(encoderDownSince({ ...base, helper: { state: "replaying", updatedAt: T("10:09:55"), lastExitAt: null, missingVideoId: "X" } }, now), null);
  assert.equal(encoderDownSince({ ...base, helper: { state: "running", updatedAt: T("10:05:00"), lastExitAt: null, missingVideoId: null } }, now), T("10:05:00"));
  assert.equal(encoderDownSince({ ...base, helper: null }, now), T("09:00:00"), "on but never started: down since it was turned on");
  assert.equal(encoderDownSince({ ...base, intent: "off" }, now), null);
});

test("a missing next video is its own notice while the stream replays the buffer", () => {
  const s: StreamNoticeInput = { ...base, helper: { state: "replaying", updatedAt: T("10:00:00"), lastExitAt: null, missingVideoId: "CCCCCCCCCC3" } };
  assert.deepEqual(liveNotices([s], T("10:00:05"), 5), [{ channelId: "UC1", kind: "live_stream_source_missing", since: T("10:00:00"), detail: "CCCCCCCCCC3" }]);
});

test("YouTube ending the broadcast is a notice for 24 hours after it, on a stream that is now off", () => {
  const s: StreamNoticeInput = { ...base, intent: "off", endedAt: T("10:00:00") };
  assert.deepEqual(liveNotices([s], T("11:00:00"), 5), [{ channelId: "UC1", kind: "live_stream_ended", since: T("10:00:00") }]);
  assert.deepEqual(liveNotices([s], T("10:00:00") + 24 * 3_600_000, 5), []);
});
