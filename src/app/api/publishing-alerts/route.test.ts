import assert from "node:assert/strict";
import test from "node:test";
import { createPublishingAlertsHandler, type PublishingAlertsDeps } from "./route";

// BL-182 stage 1 (FO-REQ-0023 §4 D): every connected channel's coverage for the badge and the bell; a channel that cannot be read
// or was never synced is left out (no false alert); the active channel is named so the client splits badge and bell.

const ALERT = { lastSyncedAt: "2026-10-13T11:00:00.000Z", coveredThrough: "2026-10-14T12:00:00Z", scheduledCount: 1, unscheduledCount: 0, daysCovered: 1, due: true, thresholdDays: 7 };

test("returns each channel's coverage; an unreadable or never-synced channel is left out", async () => {
  const deps: PublishingAlertsDeps = {
    getSession: async () => ({ user: { id: "u" } }),
    activeChannelId: async () => "UC_A",
    connectedChannelIds: async () => ["UC_A", "UC_B", "UC_C"],
    alertFor: async (channelId) => {
      if (channelId === "UC_B") throw new Error("db");
      if (channelId === "UC_C") return null;
      return { channelId, ...ALERT };
    },
  };
  const body = await (await createPublishingAlertsHandler(deps)()).json();
  assert.deepEqual(body, { activeChannelId: "UC_A", channels: [{ channelId: "UC_A", ...ALERT }] });
});

test("no session: 401", async () => {
  const deps: PublishingAlertsDeps = { getSession: async () => null, activeChannelId: async () => null, connectedChannelIds: async () => [], alertFor: async () => null };
  assert.equal((await createPublishingAlertsHandler(deps)()).status, 401);
});
