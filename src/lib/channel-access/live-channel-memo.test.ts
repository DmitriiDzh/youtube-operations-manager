import assert from "node:assert/strict";
import test from "node:test";
import { forgetLiveChannel, LIVE_CHANNEL_MEMO_TTL_MS, recallLiveChannel, rememberLiveChannel } from "./live-channel-memo";

// BL-197 (owner, Telegram 2026-10-18, msg 2988): the header's live read is reused for at most 6 hours.

const CHANNEL = { id: "UC_a", title: "A", thumbnail: null, videoCount: "1", subscriberCount: "2" };

test("live-channel memo: the TTL is 6 hours", () => {
  assert.equal(LIVE_CHANNEL_MEMO_TTL_MS, 21_600_000);
});

test("live-channel memo: recalled until just before 6 h, gone at 6 h", () => {
  const at = new Date("2026-10-18T10:00:00Z");
  rememberLiveChannel("memo-user-ttl", CHANNEL, at);
  assert.deepEqual(recallLiveChannel("memo-user-ttl", new Date("2026-10-18T15:59:59Z")), CHANNEL);
  assert.equal(recallLiveChannel("memo-user-ttl", new Date("2026-10-18T16:00:00Z")), null);
  // Expired is gone for good, even if asked with an earlier clock afterwards.
  assert.equal(recallLiveChannel("memo-user-ttl", at), null);
});

test("live-channel memo: kept per identity, and forgetting one leaves the others", () => {
  const at = new Date("2026-10-18T10:00:00Z");
  rememberLiveChannel("memo-user-1", CHANNEL, at);
  rememberLiveChannel("memo-user-2", { ...CHANNEL, id: "UC_b" }, at);
  forgetLiveChannel("memo-user-1");
  assert.equal(recallLiveChannel("memo-user-1", at), null);
  assert.equal(recallLiveChannel("memo-user-2", at)?.id, "UC_b");
  assert.equal(recallLiveChannel("memo-user-never", at), null);
});
