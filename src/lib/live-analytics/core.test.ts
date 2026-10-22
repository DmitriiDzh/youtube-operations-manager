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

// BL-214 (`producer_live_analytics`): UTC dates [startDate, endDate] are [startDate 00:00Z, endDate + 1 day 00:00Z); each broadcast
// carries what YouTube Analytics gave and `analyticsCollected` only after the FINAL pull.
test("BL-214: the producer portfolio -- the date window, per-channel figures, youtube per broadcast, analyticsCollected only when final", async () => {
  const asked: string[] = [];
  const t = (iso: string) => Date.parse(iso);
  const core = createLiveAnalyticsCore({
    now: () => new Date("2026-10-30T00:00:00.000Z"),
    samples: async (channelId, from, to) => {
      asked.push(`${channelId} ${from.toISOString()} ${to.toISOString()}`);
      if (channelId !== "UC1") return [];
      return [
        { sampledAt: t("2026-10-21T10:00:00Z"), broadcastId: "B1", viewers: 2, lifeCycleStatus: "live" },
        { sampledAt: t("2026-10-21T10:05:00Z"), broadcastId: "B1", viewers: 4, lifeCycleStatus: "live" },
        { sampledAt: t("2026-10-21T10:10:00Z"), broadcastId: "B2", viewers: 6, lifeCycleStatus: "live" },
      ];
    },
    runExits: async () => [],
    pulls: async (ids) =>
      ids.includes("B1")
        ? [
            { broadcastId: "B1", channelId: "UC1", status: "collected", final: true, attempts: 2, lastAttemptAt: new Date(), collectedAt: new Date("2026-10-26T00:00:00Z"), dataJson: JSON.stringify({ concurrent: { average: 3, peak: 5 }, curve: [], live: { views: 7, minutesWatched: 20 }, onDemand: { views: 1, minutesWatched: 2 }, reports: { concurrent: "ok", curve: "ok", split: "ok" } }), error: null },
            { broadcastId: "B2", channelId: "UC1", status: "collected", final: false, attempts: 1, lastAttemptAt: new Date(), collectedAt: new Date("2026-10-22T00:00:00Z"), dataJson: JSON.stringify({ concurrent: null, curve: null, live: null, onDemand: null, reports: { concurrent: "error", curve: "error", split: "error" } }), error: null },
          ]
        : [],
  });
  const result = await core.portfolio({ startDate: "2026-10-20", endDate: "2026-10-21" }, [{ channelId: "UC1", title: "One" }, { channelId: "UC2", title: "Two" }]);
  assert.deepEqual(asked.sort(), ["UC1 2026-10-20T00:00:00.000Z 2026-10-22T00:00:00.000Z", "UC2 2026-10-20T00:00:00.000Z 2026-10-22T00:00:00.000Z"]);
  assert.deepEqual([result.startDate, result.endDate, result.source], ["2026-10-20", "2026-10-21", "local"]);
  const [one, two] = result.channels;
  assert.deepEqual([one.channelId, one.title, one.totals.onAirMs, one.totals.peakViewers], ["UC1", "One", 10 * 60_000, 6]);
  assert.deepEqual(
    one.broadcasts.map((b) => [b.broadcastId, b.firstSampleAt, b.lastSampleAt, b.youtube?.live?.views ?? null, b.analyticsCollected]),
    [
      ["B1", "2026-10-21T10:00:00.000Z", "2026-10-21T10:05:00.000Z", 7, true],
      ["B2", "2026-10-21T10:10:00.000Z", "2026-10-21T10:10:00.000Z", null, false],
    ]
  );
  assert.deepEqual([two.totals.samples, two.totals.peakViewers, two.broadcasts], [0, null, []]);
});
