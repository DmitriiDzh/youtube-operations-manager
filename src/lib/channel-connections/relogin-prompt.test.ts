import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectionHealth } from "./contracts";
import { planReloginPrompt } from "./relogin-prompt";

const row = (channelId: string, state: ConnectionHealth["state"]): ConnectionHealth => ({
  channelId,
  title: channelId,
  connectedEmail: `${channelId}@example.com`,
  isActive: false,
  state,
  ageDays: null,
  daysLeft: null,
  checkedAt: null,
});

test("no popup for ok / unknown connections", () => {
  assert.deepEqual(planReloginPrompt([row("A", "ok"), row("B", "unknown")], false), { mode: "none", rows: [] });
  assert.deepEqual(planReloginPrompt([], false), { mode: "none", rows: [] });
});

test("any reauth_required makes the popup blocking, listing every account that needs attention, dead ones first", () => {
  const prompt = planReloginPrompt([row("A", "expiring_soon"), row("B", "reauth_required"), row("C", "ok")], false);
  assert.equal(prompt.mode, "blocking");
  assert.deepEqual(prompt.rows.map((r) => r.channelId), ["B", "A"]);
});

test("blocking cannot be dismissed by 'Later'", () => {
  assert.equal(planReloginPrompt([row("B", "reauth_required")], true).mode, "blocking");
});

test("only expiring accounts: a dismissable popup, which 'Later' hides", () => {
  assert.deepEqual(planReloginPrompt([row("A", "expiring_soon")], false).mode, "soft");
  assert.deepEqual(planReloginPrompt([row("A", "expiring_soon")], true), { mode: "none", rows: [] });
});

// BL-126: the Google Cloud grant is listed with the channels but never blocks the app (it only feeds quota statistics).
const cloudRow = (state: ConnectionHealth["state"]): ConnectionHealth => ({ ...row("google-cloud-connection", state), kind: "cloud" });

test("a dead Cloud grant alone gives the dismissable dialog, not the blocking one, and 'Later' hides it", () => {
  const prompt = planReloginPrompt([row("A", "ok"), cloudRow("reauth_required")], false);
  assert.equal(prompt.mode, "soft");
  assert.deepEqual(prompt.rows.map((r) => r.channelId), ["google-cloud-connection"]);
  assert.deepEqual(planReloginPrompt([cloudRow("reauth_required")], true), { mode: "none", rows: [] });
});

test("a Cloud grant that expires soon is listed in the soft dialog beside a channel that expires soon", () => {
  const prompt = planReloginPrompt([row("A", "expiring_soon"), cloudRow("expiring_soon")], false);
  assert.equal(prompt.mode, "soft");
  assert.deepEqual(prompt.rows.map((r) => r.channelId), ["A", "google-cloud-connection"]);
});

test("a dead channel keeps the hard stop even when Cloud is fine, and a dead Cloud is listed in the blocking dialog first-class", () => {
  assert.equal(planReloginPrompt([row("B", "reauth_required"), cloudRow("ok")], false).mode, "blocking");
  const both = planReloginPrompt([row("B", "reauth_required"), cloudRow("reauth_required")], true);
  assert.equal(both.mode, "blocking");
  assert.deepEqual(both.rows.map((r) => r.channelId), ["B", "google-cloud-connection"]);
});
