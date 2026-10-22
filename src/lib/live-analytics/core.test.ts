import assert from "node:assert/strict";
import test from "node:test";
import { createLiveAnalyticsCore } from "./index";

// BL-213: the summary covers the last `days` up to now -- the store is asked for exactly that window, and a run exit after
// "now" (a clock step) is not counted.
test("BL-213: the summary asks for [now - days, now) and labels the range", async () => {
  const now = new Date("2026-10-22T12:00:00.000Z");
  const asked: string[] = [];
  const core = createLiveAnalyticsCore({
    now: () => now,
    samples: async (channelId, from, to) => {
      asked.push(`samples ${channelId} ${from.toISOString()} ${to.toISOString()}`);
      return [
        { sampledAt: now.getTime() - 10 * 60_000, broadcastId: "B1", viewers: 3, lifeCycleStatus: "live" },
        { sampledAt: now.getTime() - 5 * 60_000, broadcastId: "B1", viewers: 5, lifeCycleStatus: "live" },
      ];
    },
    pulls: async (ids) => {
      asked.push(`pulls ${ids.join(",")}`);
      return [{ broadcastId: "B1", channelId: "UC1", status: "collected", final: false, attempts: 1, lastAttemptAt: now, collectedAt: now, dataJson: JSON.stringify({ concurrent: { average: 4, peak: 9 }, curve: [], live: { views: 10, minutesWatched: 50 }, onDemand: null, reports: { concurrent: "ok", curve: "ok", split: "ok" } }), error: null }];
    },
    runExits: async (channelId, from) => {
      asked.push(`exits ${channelId} ${from.toISOString()}`);
      return [
        { at: now.getTime() - 60_000, kind: "encoder_run_exit", cause: "encoder_exit" },
        { at: now.getTime() + 60_000, kind: "encoder_run_exit", cause: "encoder_exit" },
      ];
    },
  });
  const summary = await core.summary("UC1", 2);
  assert.deepEqual(asked.sort(), ["exits UC1 2026-10-20T12:00:00.000Z", "pulls B1", "samples UC1 2026-10-20T12:00:00.000Z 2026-10-22T12:00:00.000Z"]);
  assert.deepEqual(summary.analytics, [{ broadcastId: "B1", status: "collected", final: false, collectedAt: now.toISOString(), concurrent: { average: 4, peak: 9 }, live: { views: 10, minutesWatched: 50 }, onDemand: null }]);
  assert.deepEqual(summary.range, { from: "2026-10-20T12:00:00.000Z", to: "2026-10-22T12:00:00.000Z", days: 2 });
  assert.equal(summary.totals.interruptions, 1);
  assert.equal(summary.totals.onAirMs, 5 * 60_000);
  assert.equal(summary.totals.peakViewers, 5);
});
