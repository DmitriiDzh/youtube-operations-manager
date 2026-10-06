import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundFailureBackoff, credentialUserIdFor, errorCodeOf } from "./policy";

// BL-141/BL-142 shared rules (owner, Telegram 2026-10-06, msgs 1865/1874). Expected values written by hand.

test("the session's active channel uses the session user; any other channel its own connected user, or none", () => {
  const ctx = { activeChannelId: "UC_A", sessionUserId: "uS" };
  assert.equal(credentialUserIdFor({ channelId: "UC_A", connectedUserId: "uA" }, ctx), "uS");
  assert.equal(credentialUserIdFor({ channelId: "UC_A", connectedUserId: null }, ctx), "uS");
  assert.equal(credentialUserIdFor({ channelId: "UC_B", connectedUserId: "uB" }, ctx), "uB");
  assert.equal(credentialUserIdFor({ channelId: "UC_B", connectedUserId: null }, ctx), null);
  assert.equal(credentialUserIdFor({ channelId: "UC_A", connectedUserId: "uA" }, { activeChannelId: null, sessionUserId: "uS" }), "uA");
});

test("errorCodeOf reads a string code from an Error and nothing else", () => {
  assert.equal(errorCodeOf(Object.assign(new Error("x"), { code: "CHANNEL_NOT_ACTIVE" })), "CHANNEL_NOT_ACTIVE");
  assert.equal(errorCodeOf(new Error("plain")), undefined);
  assert.equal(errorCodeOf({ code: "NOT_AN_ERROR" }), undefined);
  assert.equal(errorCodeOf(Object.assign(new Error("x"), { code: 401 })), undefined);
});

test("a failed background channel is held back for 6 hours; a success clears it", () => {
  let now = new Date("2026-10-06T12:00:00Z");
  const backoff = createBackgroundFailureBackoff({ now: () => now });
  assert.equal(backoff.blocking("UC_B"), null);
  backoff.recordFailure("UC_B", "token revoked");
  now = new Date("2026-10-06T17:59:59Z");
  assert.equal(backoff.blocking("UC_B")?.reason, "token revoked");
  now = new Date("2026-10-06T18:00:00Z");
  assert.equal(backoff.blocking("UC_B"), null, "exactly 6 hours later it may run again");
  backoff.recordFailure("UC_C", "x");
  backoff.recordSuccess("UC_C");
  assert.equal(backoff.blocking("UC_C"), null);
});
