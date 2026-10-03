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
