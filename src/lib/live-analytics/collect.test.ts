import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createBroadcastAnalyticsCollector, type CollectorDeps, type StoredPull } from "./collect";

// BL-212 (LIVE_ANALYTICS_PLAN.md stage 2): when an ended broadcast's YouTube Analytics is pulled, what is kept, and what is never
// retried. Expected values by hand from the plan; the API's row shapes from its official reports (channel_reports, dimensions).

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 22, 12, 0);
type Query = { channelId: string; videoId: string; startDate: string; endDate: string; metricNames: readonly string[]; dimensions?: string };

function httpError(status: number, message = "boom") {
  return Object.assign(new Error(message), { response: { status } });
}

const OK_ROWS: Record<string, Array<{ dimensions: Record<string, string>; metrics: Record<string, number> }>> = {
  "": [{ dimensions: {}, metrics: { averageConcurrentViewers: 12.5, peakConcurrentViewers: 30 } }],
  livestreamPosition: [
    { dimensions: { livestreamPosition: "1" }, metrics: { averageConcurrentViewers: 15, peakConcurrentViewers: 30 } },
    { dimensions: { livestreamPosition: "0" }, metrics: { averageConcurrentViewers: 10, peakConcurrentViewers: 12 } },
  ],
  liveOrOnDemand: [
    { dimensions: { liveOrOnDemand: "LIVE" }, metrics: { views: 100, estimatedMinutesWatched: 900 } },
    { dimensions: { liveOrOnDemand: "ON_DEMAND" }, metrics: { views: 40, estimatedMinutesWatched: 120 } },
  ],
};

function harness(opts: { broadcasts?: Array<{ broadcastId: string; firstSampleAt: number; lastSampleAt: number }>; rows?: StoredPull[]; fail?: (q: Query) => unknown } = {}) {
  let now = NOW;
  const queries: Query[] = [];
  const saved = new Map<string, StoredPull>((opts.rows ?? []).map((r) => [r.broadcastId, r]));
  const deps: CollectorDeps = {
    broadcasts: async () => (opts.broadcasts ?? [{ broadcastId: "B1", firstSampleAt: Date.UTC(2026, 9, 21, 22, 0), lastSampleAt: NOW - 2 * HOUR }]).map((b) => ({ channelId: "UC1", ...b })),
    stored: async (ids) => ids.flatMap((id) => (saved.has(id) ? [saved.get(id)!] : [])),
    save: async (row) => void saved.set(row.broadcastId, row),
    query: async (q) => {
      queries.push(q);
      const failure = opts.fail?.(q);
      if (failure) throw failure;
      return OK_ROWS[q.dimensions ?? ""];
    },
    now: () => new Date(now),
  };
  return { collector: createBroadcastAnalyticsCollector(deps), queries, saved, advance: (ms: number) => void (now += ms) };
}

test("BL-212: an ended broadcast with no pull is pulled -- three reports for that video, dates from the day before its first sample", async () => {
  const h = harness();
  await h.collector.tick();
  assert.deepEqual(
    h.queries.map((q) => [q.channelId, q.videoId, q.startDate, q.endDate, q.dimensions ?? "", q.metricNames.join(",")]),
    [
      ["UC1", "B1", "2026-10-20", "2026-10-22", "", "averageConcurrentViewers,peakConcurrentViewers"],
      ["UC1", "B1", "2026-10-20", "2026-10-22", "livestreamPosition", "averageConcurrentViewers,peakConcurrentViewers"],
      ["UC1", "B1", "2026-10-20", "2026-10-22", "liveOrOnDemand", "views,estimatedMinutesWatched"],
    ]
  );
  const row = h.saved.get("B1")!;
  assert.deepEqual({ ...row, data: JSON.parse(row.dataJson!) }, {
    broadcastId: "B1",
    channelId: "UC1",
    status: "collected",
    final: false,
    attempts: 1,
    lastAttemptAt: new Date(NOW),
    collectedAt: new Date(NOW),
    dataJson: row.dataJson,
    error: null,
    data: {
      concurrent: { average: 12.5, peak: 30 },
      curve: [[0, 10, 12], [1, 15, 30]],
      live: { views: 100, minutesWatched: 900 },
      onDemand: { views: 40, minutesWatched: 120 },
      reports: { concurrent: "ok", curve: "ok", split: "ok" },
    },
  });
});

test("BL-212: a broadcast still on (last sample under an hour old) is not pulled", async () => {
  const h = harness({ broadcasts: [{ broadcastId: "B1", firstSampleAt: NOW - 5 * HOUR, lastSampleAt: NOW - 59 * 60_000 }] });
  await h.collector.tick();
  assert.equal(h.queries.length, 0);
});

test("BL-212: a collected pull is pulled once more after 4 days (final), then never again", async () => {
  const last = NOW - 2 * HOUR;
  const h = harness({ broadcasts: [{ broadcastId: "B1", firstSampleAt: last - HOUR, lastSampleAt: last }] });
  await h.collector.tick();
  h.advance(4 * 24 * HOUR - 2 * HOUR - 1); // 1 ms before last + 4 days
  await h.collector.tick();
  assert.equal(h.queries.length, 3);
  h.advance(1);
  await h.collector.tick();
  assert.equal(h.queries.length, 6);
  assert.deepEqual([h.saved.get("B1")!.final, h.saved.get("B1")!.attempts], [true, 2]);
  h.advance(30 * 24 * HOUR);
  await h.collector.tick();
  assert.equal(h.queries.length, 6);
});

test("BL-212: a video YouTube no longer has (404/403 on every report) is unavailable and never asked again", async () => {
  const h = harness({ fail: () => httpError(404) });
  await h.collector.tick();
  assert.equal(h.saved.get("B1")!.status, "unavailable");
  h.advance(10 * 24 * HOUR);
  await h.collector.tick();
  assert.equal(h.queries.length, 3);
});

test("BL-212: a failure is retried after 6 hours, at most 5 attempts", async () => {
  const h = harness({ fail: () => httpError(500) });
  await h.collector.tick();
  assert.deepEqual([h.saved.get("B1")!.status, h.saved.get("B1")!.attempts, h.saved.get("B1")!.dataJson], ["failed", 1, null]);
  h.advance(6 * HOUR - 1);
  await h.collector.tick();
  assert.equal(h.queries.length, 3, "not before 6 hours");
  for (let i = 0; i < 10; i++) {
    h.advance(6 * HOUR);
    await h.collector.tick();
  }
  assert.equal(h.saved.get("B1")!.attempts, 5);
  assert.equal(h.queries.length, 15);
});

test("BL-212: one report YouTube refuses (400) leaves the others kept; the pull counts as collected", async () => {
  const h = harness({ fail: (q) => (q.dimensions === "liveOrOnDemand" ? httpError(400, "The query is not supported.") : null) });
  await h.collector.tick();
  const row = h.saved.get("B1")!;
  const data = JSON.parse(row.dataJson!);
  assert.equal(row.status, "collected");
  assert.deepEqual(data.reports, { concurrent: "ok", curve: "ok", split: "unsupported" });
  assert.deepEqual([data.live, data.onDemand], [null, null]);
});

test("BL-212: reads switched off or the quota spent stop the tick -- nothing saved, no attempt counted", async () => {
  for (const code of ["analytics_reads_disabled", "youtube_quota_exceeded"] as const) {
    const h = harness({
      broadcasts: [
        { broadcastId: "B1", firstSampleAt: NOW - 9 * HOUR, lastSampleAt: NOW - 8 * HOUR },
        { broadcastId: "B2", firstSampleAt: NOW - 7 * HOUR, lastSampleAt: NOW - 6 * HOUR },
      ],
      fail: () => new DomainError({ code, message: code }),
    });
    await h.collector.tick();
    assert.equal(h.queries.length, 1, code);
    assert.equal(h.saved.size, 0, code);
  }
});

test("BL-212: at most 4 broadcasts per tick, oldest ended first", async () => {
  const broadcasts = [6, 5, 4, 3, 2].map((n) => ({ broadcastId: `B${n}`, firstSampleAt: NOW - (n + 1) * HOUR, lastSampleAt: NOW - n * HOUR }));
  const h = harness({ broadcasts });
  await h.collector.tick();
  assert.deepEqual([...new Set(h.queries.map((q) => q.videoId))], ["B6", "B5", "B4", "B3"]);
});

// Independent review (2026-10-22): the final pull must not repeat every hour when it fails, and must not lose what the first pull got.
test("BL-212: a final pull that finds the video gone keeps the first pull's data, becomes final and is not asked again", async () => {
  let gone = false;
  const last = NOW - 2 * HOUR;
  const h = harness({ broadcasts: [{ broadcastId: "B1", firstSampleAt: last - HOUR, lastSampleAt: last }], fail: () => (gone ? httpError(404) : null) });
  await h.collector.tick();
  const first = h.saved.get("B1")!.dataJson;
  gone = true;
  h.advance(4 * 24 * HOUR);
  await h.collector.tick();
  const row = h.saved.get("B1")!;
  assert.deepEqual([row.status, row.final, row.attempts, row.dataJson], ["collected", true, 2, first]);
  h.advance(HOUR);
  await h.collector.tick();
  h.advance(30 * 24 * HOUR);
  await h.collector.tick();
  assert.equal(h.queries.length, 6, "no third pull");
});

test("BL-212: a final pull that keeps failing (500) is retried every 6 hours at most, within 5 attempts in all", async () => {
  let failing = false;
  const last = NOW - 2 * HOUR;
  const h = harness({ broadcasts: [{ broadcastId: "B1", firstSampleAt: last - HOUR, lastSampleAt: last }], fail: () => (failing ? httpError(500) : null) });
  await h.collector.tick();
  failing = true;
  h.advance(4 * 24 * HOUR);
  await h.collector.tick();
  assert.equal(h.queries.length, 6);
  h.advance(HOUR);
  await h.collector.tick();
  assert.equal(h.queries.length, 6, "not every hour");
  for (let i = 0; i < 20; i++) {
    h.advance(6 * HOUR);
    await h.collector.tick();
  }
  const row = h.saved.get("B1")!;
  assert.deepEqual([row.status, row.final, row.attempts], ["collected", false, 5]);
  assert.equal(h.queries.length, 15);
});

test("BL-212: a report that does not answer in the final pull keeps the first pull's value", async () => {
  let splitFails = false;
  const last = NOW - 2 * HOUR;
  const h = harness({ broadcasts: [{ broadcastId: "B1", firstSampleAt: last - HOUR, lastSampleAt: last }], fail: (q) => (splitFails && q.dimensions === "liveOrOnDemand" ? httpError(500) : null) });
  await h.collector.tick();
  splitFails = true;
  h.advance(4 * 24 * HOUR);
  await h.collector.tick();
  const data = JSON.parse(h.saved.get("B1")!.dataJson!);
  assert.equal(h.saved.get("B1")!.final, true);
  assert.deepEqual([data.live, data.onDemand, data.reports.split], [{ views: 100, minutesWatched: 900 }, { views: 40, minutesWatched: 120 }, "ok"]);
});
