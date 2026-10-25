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

// ---------------------------------------------------------------------------
// BL-222 (LIVE_ANALYTICS_PLAN.md §6): the summary on the other computers. Expected values by hand from the summary rules (§2): two
// live samples 5 minutes apart are one 5-minute live interval (the last sample opens no interval).
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-25T12:00:00.000Z");
const MIN = 60_000;
type Sample = { channelId: string; sampledAt: number; broadcastId: string; viewers: number | null; lifeCycleStatus: string };
function coreWith(samples: Sample[], peers?: import("./index").PeerLiveAnalytics[]) {
  return createLiveAnalyticsCore({
    now: () => NOW,
    samples: async (channelId, from, to) => samples.filter((s) => s.channelId === channelId && s.sampledAt >= from.getTime() && s.sampledAt < to.getTime()),
    runExits: async () => [],
    pulls: async () => [],
    ...(peers ? { peers: async () => peers } : {}),
  });
}
const live = (channelId: string, minutesAgo: number, viewers: number): Sample => ({ channelId, sampledAt: NOW.getTime() - minutesAgo * MIN, broadcastId: "AAAAAAAAAA1", viewers, lifeCycleStatus: "live" });
const figures = (samples: number, onAirMs: number, peak: number | null) => ({ samples, onAirMs, notLiveMs: 0, dataGaps: 0, viewerHours: 0, averageViewers: peak, peakViewers: peak, interruptions: 0 });
const sharedRange = (days: 1 | 7 | 30 | 90, samples: number, peak: number | null) => ({
  days,
  from: new Date(NOW.getTime() - days * 86_400_000).toISOString(),
  to: NOW.toISOString(),
  summary: { totals: figures(samples, samples * 5 * MIN, peak), days: [], hours: [], broadcasts: [], analytics: [] },
});

test("AC-LA5-02: four ranges per channel sampled in 90 days, each the local summary; an older channel is left out", async () => {
  const core = coreWith([live("UC1", 10, 3), live("UC1", 5, 5), live("UC2", 100 * 24 * 60, 7), live("UC2", 100 * 24 * 60 - 5, 7)]);
  const shared = await core.shared(["UC1", "UC2"]);
  assert.deepEqual(shared.map((c) => c.channelId), ["UC1"]);
  assert.deepEqual(shared[0].ranges.map((r) => r.days), [1, 7, 30, 90]);
  for (const r of shared[0].ranges) {
    assert.equal(r.summary.totals.samples, 2);
    assert.equal(r.summary.totals.onAirMs, 5 * MIN);
    assert.equal(r.summary.totals.peakViewers, 5);
    assert.equal(r.to, NOW.toISOString());
    assert.equal(r.from, new Date(NOW.getTime() - r.days * 86_400_000).toISOString());
    assert.equal("source" in r.summary || "range" in r.summary, false, "only the summary itself is shared");
  }
  assert.deepEqual(await core.shared([]), []);
});

test("AC-LA5-03: local samples win even when a peer has more", async () => {
  const peer = { deviceId: "mac-1", hostName: "Mac mini", updatedAt: NOW.toISOString(), channels: [{ channelId: "UC1", ranges: [sharedRange(7, 200, 40)] }] };
  const summary = await coreWith([live("UC1", 10, 3), live("UC1", 5, 5)], [peer]).summary("UC1", 7);
  assert.deepEqual(summary.source, { kind: "local" });
  assert.equal(summary.totals.samples, 2);
});

test("AC-LA5-03: no local samples -> the newest peer whose range has samples, with its host and time", async () => {
  const older = { deviceId: "old-mac", hostName: "Old Mac", updatedAt: "2026-10-25T11:00:00.000Z", channels: [{ channelId: "UC1", ranges: [sharedRange(7, 50, 20)] }] };
  const newer = { deviceId: "mac-1", hostName: "Mac mini", updatedAt: "2026-10-25T11:55:00.000Z", channels: [{ channelId: "UC1", ranges: [sharedRange(7, 100, 30)] }] };
  const summary = await coreWith([], [older, newer]).summary("UC1", 7);
  assert.deepEqual(summary.source, { kind: "peer", deviceId: "mac-1", hostName: "Mac mini", updatedAt: "2026-10-25T11:55:00.000Z" });
  assert.equal(summary.totals.samples, 100);
  assert.equal(summary.totals.peakViewers, 30);
  assert.deepEqual(summary.range, { from: "2026-10-18T12:00:00.000Z", to: NOW.toISOString(), days: 7 });
});

test("AC-LA5-03: a peer whose range has 0 samples is skipped for an older one that has some", async () => {
  const empty = { deviceId: "mac-1", hostName: "Mac mini", updatedAt: "2026-10-25T11:55:00.000Z", channels: [{ channelId: "UC1", ranges: [sharedRange(1, 0, null)] }] };
  const withData = { deviceId: "mac-2", hostName: "Mac Studio", updatedAt: "2026-10-25T11:00:00.000Z", channels: [{ channelId: "UC1", ranges: [sharedRange(1, 12, 9)] }] };
  const summary = await coreWith([], [empty, withData]).summary("UC1", 1);
  assert.deepEqual(summary.source, { kind: "peer", deviceId: "mac-2", hostName: "Mac Studio", updatedAt: "2026-10-25T11:00:00.000Z" });
  assert.equal(summary.totals.samples, 12);
});

test("AC-LA5-03: no peer, another channel's peer, or a range no one shares (3 days) -> local with zero figures", async () => {
  const peer = { deviceId: "mac-1", hostName: "Mac mini", updatedAt: NOW.toISOString(), channels: [{ channelId: "UC2", ranges: [sharedRange(7, 10, 5)] }, { channelId: "UC1", ranges: [sharedRange(7, 10, 5)] }] };
  for (const [core, channelId, days] of [
    [coreWith([], []), "UC1", 7],
    [coreWith([]), "UC1", 7],
    [coreWith([], [peer]), "UC3", 7],
    [coreWith([], [peer]), "UC1", 3],
  ] as const) {
    const summary = await core.summary(channelId, days);
    assert.deepEqual(summary.source, { kind: "local" }, `${channelId} ${days}`);
    assert.equal(summary.totals.samples, 0);
    assert.equal(summary.totals.peakViewers, null);
  }
});
