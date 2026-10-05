import assert from "node:assert/strict";
import test from "node:test";
import { createAssetPerformanceServices, type AssetForPerformanceJoin, type VideoForPerformanceJoin } from "./services";
import { DomainError } from "./contracts";

function asset(overrides: Partial<AssetForPerformanceJoin> & { assetId: string }): AssetForPerformanceJoin {
  return {
    assetType: "thumbnail",
    title: null,
    referenceKind: "url",
    referenceValue: "https://example.com/a.png",
    linkedVideoId: null,
    ...overrides,
  };
}

function video(overrides: Partial<VideoForPerformanceJoin> & { videoId: string }): VideoForPerformanceJoin {
  return {
    channelId: "UC_A",
    title: "Untitled",
    publishedAt: "2026-01-01T20:00:00.000Z",
    viewCount: null,
    likeCount: null,
    commentCount: null,
    durationSeconds: null,
    lastSyncedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createFixture(
  overrides: Partial<{
    assets: AssetForPerformanceJoin[];
    videos: VideoForPerformanceJoin[];
    metricRows: Array<{ videoId: string; metricDate: string; metricName: string; metricValue: number }>;
  }> = {}
) {
  const listMetricsCalls: unknown[] = [];
  const services = createAssetPerformanceServices({
    listAssetsByChannel: async () => ({ assets: overrides.assets ?? [] }),
    listVideosByChannel: async () => overrides.videos ?? [],
    listMetrics: async (input) => {
      listMetricsCalls.push(input);
      return { channelId: "UC_A", rows: overrides.metricRows ?? [] };
    },
  });
  return { services, listMetricsCalls };
}

// AC-PERF-01
test("returns every catalogued asset whose linkedVideoId resolves to a synced video on the same channel, with lifetime counters", async () => {
  const { services } = createFixture({
    assets: [asset({ assetId: "a1", linkedVideoId: "v1" })],
    videos: [video({ videoId: "v1", viewCount: 1000, likeCount: 50, commentCount: 5, durationSeconds: 600 })],
  });

  const result = await services.listAssetPerformance({ channelId: "UC_A" });

  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0]?.assetId, "a1");
  assert.deepEqual(result.assets[0]?.linkedVideo, {
    videoId: "v1",
    title: "Untitled",
    publishedAt: "2026-01-01T20:00:00.000Z",
    lifetimeViewCount: 1000,
    lifetimeLikeCount: 50,
    lifetimeCommentCount: 5,
    durationSeconds: 600,
    lifetimeCountersAsOf: "2026-06-01T00:00:00.000Z",
    ageAlignedPerformanceValue: null,
  });
});

// AC-PERF-02
test("excludes an unlinked asset and counts it in excludedForMissingLink.unlinked", async () => {
  const { services } = createFixture({
    assets: [asset({ assetId: "a1", linkedVideoId: null })],
  });

  const result = await services.listAssetPerformance({ channelId: "UC_A" });

  assert.deepEqual(result.assets, []);
  assert.equal(result.excludedForMissingLink.unlinked, 1);
});

// AC-PERF-03: a channel-scoped video read (`listVideosByChannel(channelId)`) cannot structurally
// distinguish "linkedVideoId was never synced at all" from "linkedVideoId belongs to a different
// channel" -- both are absent from this channel's own video list. Both count under the SAME
// reason, `linkedVideoNotOnChannel` (see contracts.ts's own doc comment for the full reasoning).
test("excludes an asset whose linkedVideoId does not resolve to any video on the requesting channel and counts it in excludedForMissingLink.linkedVideoNotOnChannel", async () => {
  const { services } = createFixture({
    assets: [asset({ assetId: "a1", linkedVideoId: "does-not-exist" })],
  });

  const result = await services.listAssetPerformance({ channelId: "UC_A" });

  assert.deepEqual(result.assets, []);
  assert.equal(result.excludedForMissingLink.linkedVideoNotOnChannel, 1);
});

// AC-PERF-04: defense-in-depth (AGENTS.md §F) -- even if a dependency somehow returned a video
// belonging to a different channel (never assumed to be impossible just because the real
// dependency currently filters by channelId itself), this capability's own explicit channelId
// check still catches it and never leaks it into the result.
test("excludes an asset whose linkedVideoId resolves to a video on a DIFFERENT channel (defense-in-depth check) and never leaks it into the result", async () => {
  const { services } = createFixture({
    assets: [asset({ assetId: "a1", linkedVideoId: "v1" })],
    videos: [video({ videoId: "v1", channelId: "UC_OTHER" })],
  });

  const result = await services.listAssetPerformance({ channelId: "UC_A" });

  assert.deepEqual(result.assets, []);
  assert.equal(result.excludedForMissingLink.linkedVideoNotOnChannel, 1);
});

// AC-PERF-05: `listAssetsByChannel` itself is the reused asset-catalog function that already
// implements filtering (AGENTS.md §D) -- this test verifies the filter is forwarded unchanged,
// never reimplemented here.
test("assetType is forwarded unchanged to listAssetsByChannel", async () => {
  let captured: unknown;
  const services = createAssetPerformanceServices({
    listAssetsByChannel: async (input) => {
      captured = input;
      return { assets: [] };
    },
    listVideosByChannel: async () => [],
    listMetrics: async () => ({ channelId: "UC_A", rows: [] }),
  });

  await services.listAssetPerformance({ channelId: "UC_A", assetType: "thumbnail" });

  assert.deepEqual(captured, { channelId: "UC_A", assetType: "thumbnail" });
});

function contiguousDailyRows(videoId: string, days: number, valuePerDay: number) {
  const rows: Array<{ videoId: string; metricDate: string; metricName: string; metricValue: number }> = [];
  for (let offset = 0; offset <= days; offset += 1) {
    const date = new Date(Date.UTC(2026, 4, 1 + offset)); // 2026-05-01 + offset days
    rows.push({ videoId, metricDate: date.toISOString().slice(0, 10), metricName: "views", metricValue: valuePerDay });
  }
  return rows;
}

// AC-PERF-06
test("performanceMetric/performanceDayOffset must be given together -- rejected as validation_failed otherwise", async () => {
  const { services } = createFixture({ assets: [] });

  await assert.rejects(
    () => services.listAssetPerformance({ channelId: "UC_A", performanceMetric: "views", credentialRef: { userId: "u1" } }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
  await assert.rejects(
    () => services.listAssetPerformance({ channelId: "UC_A", performanceDayOffset: 3 }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("performanceMetric/performanceDayOffset compute an age-aligned value via the shared helper, null when coverage doesn't reach that day -- a JOIN, never a filter (row stays, never excluded)", async () => {
  const { services, listMetricsCalls } = createFixture({
    assets: [
      asset({ assetId: "a1", linkedVideoId: "has_coverage" }),
      asset({ assetId: "a2", linkedVideoId: "no_coverage" }),
    ],
    videos: [
      video({ videoId: "has_coverage", publishedAt: "2026-05-01T20:00:00.000Z" }),
      video({ videoId: "no_coverage", publishedAt: "2026-05-01T20:00:00.000Z" }),
    ],
    metricRows: contiguousDailyRows("has_coverage", 3, 100), // cumulative through day 3: 400
  });

  const result = await services.listAssetPerformance({
    channelId: "UC_A",
    performanceMetric: "views",
    performanceDayOffset: 3,
    credentialRef: { userId: "u1" },
  });

  assert.equal(result.assets.length, 2); // both rows present -- a JOIN, not a filter
  const withCoverage = result.assets.find((a) => a.linkedVideo.videoId === "has_coverage");
  const withoutCoverage = result.assets.find((a) => a.linkedVideo.videoId === "no_coverage");
  assert.equal(withCoverage?.linkedVideo.ageAlignedPerformanceValue, 400);
  assert.equal(withoutCoverage?.linkedVideo.ageAlignedPerformanceValue, null);
  assert.deepEqual(result.performanceAlignment, { metricName: "views", dayOffset: 3 });
  assert.equal(listMetricsCalls.length, 1);
  assert.deepEqual(listMetricsCalls[0], { credentialRef: { userId: "u1" }, channelId: "UC_A", metricNames: ["views"] });
});

// The common real-world case slice K's own round-3 review flagged: a video published before
// regular collection began for its channel has real data at LATER days but no day-0 coverage --
// `ageAlignedPerformanceValue` is honestly null at ANY requested day (contiguous coverage from
// day 0 never exists), but the row is still kept (a JOIN, never a filter) with its lifetime
// counters intact, and never counted as excluded (that counter is reserved for a broken LINK, not
// missing performance data).
test("a video with real data at later days but no day-0 coverage still keeps its row, with null ageAlignedPerformanceValue and intact lifetime counters, never counted as excluded", async () => {
  const { services } = createFixture({
    assets: [asset({ assetId: "a1", linkedVideoId: "old_video" })],
    videos: [video({ videoId: "old_video", publishedAt: "2026-01-01T20:00:00.000Z", viewCount: 5000, likeCount: 200 })],
    // Days 3-6 have real data; day 0/1/2 were never collected (collection started late).
    metricRows: [
      { videoId: "old_video", metricDate: "2026-01-04", metricName: "views", metricValue: 100 }, // day 3
      { videoId: "old_video", metricDate: "2026-01-05", metricName: "views", metricValue: 100 }, // day 4
      { videoId: "old_video", metricDate: "2026-01-06", metricName: "views", metricValue: 100 }, // day 5
      { videoId: "old_video", metricDate: "2026-01-07", metricName: "views", metricValue: 100 }, // day 6
    ],
  });

  const result = await services.listAssetPerformance({
    channelId: "UC_A",
    performanceMetric: "views",
    performanceDayOffset: 5,
    credentialRef: { userId: "u1" },
  });

  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0]?.linkedVideo.ageAlignedPerformanceValue, null);
  assert.equal(result.assets[0]?.linkedVideo.lifetimeViewCount, 5000);
  assert.equal(result.assets[0]?.linkedVideo.lifetimeLikeCount, 200);
  assert.deepEqual(result.excludedForMissingLink, { unlinked: 0, linkedVideoNotOnChannel: 0 });
});

test("listMetrics is never called when performanceMetric is not requested (no unnecessary analytics read)", async () => {
  const { services, listMetricsCalls } = createFixture({
    assets: [asset({ assetId: "a1", linkedVideoId: "v1" })],
    videos: [video({ videoId: "v1" })],
  });

  await services.listAssetPerformance({ channelId: "UC_A" });

  assert.equal(listMetricsCalls.length, 0);
});

// AC-PERF-08
test("sort modes are explicit: linkedVideoPublicationDate (newest first), lifetimeViewCount, and omitting sort entirely defaults to linkedVideoPublicationDate", async () => {
  const { services } = createFixture({
    assets: [
      asset({ assetId: "old_video", linkedVideoId: "old" }),
      asset({ assetId: "new_video", linkedVideoId: "new" }),
      asset({ assetId: "popular", linkedVideoId: "popular" }),
    ],
    videos: [
      video({ videoId: "old", publishedAt: "2026-01-01T00:00:00.000Z", viewCount: 10 }),
      video({ videoId: "new", publishedAt: "2026-06-01T00:00:00.000Z", viewCount: 5 }),
      video({ videoId: "popular", publishedAt: "2026-03-01T00:00:00.000Z", viewCount: 9999 }),
    ],
  });

  const byDate = await services.listAssetPerformance({ channelId: "UC_A", sort: "linkedVideoPublicationDate" });
  assert.deepEqual(byDate.assets.map((a) => a.assetId), ["new_video", "popular", "old_video"]);

  const byViews = await services.listAssetPerformance({ channelId: "UC_A", sort: "lifetimeViewCount" });
  assert.deepEqual(byViews.assets.map((a) => a.assetId), ["popular", "old_video", "new_video"]);

  // Omitting `sort` entirely, with more than one entry, must default to the SAME order as
  // explicitly requesting linkedVideoPublicationDate -- not just happen to match on a
  // single-entry result set (AC-PERF-01's own fixture only ever has one asset).
  const byDefault = await services.listAssetPerformance({ channelId: "UC_A" });
  assert.deepEqual(byDefault.assets.map((a) => a.assetId), ["new_video", "popular", "old_video"]);
});

test("sort: performanceMetric ranks by ageAlignedPerformanceValue, descending, with null values sorted last", async () => {
  const { services } = createFixture({
    assets: [
      asset({ assetId: "high", linkedVideoId: "high" }),
      asset({ assetId: "low", linkedVideoId: "low" }),
      asset({ assetId: "no_coverage", linkedVideoId: "no_coverage" }),
    ],
    videos: [
      video({ videoId: "high", publishedAt: "2026-05-01T20:00:00.000Z" }),
      video({ videoId: "low", publishedAt: "2026-05-01T20:00:00.000Z" }),
      video({ videoId: "no_coverage", publishedAt: "2026-05-01T20:00:00.000Z" }),
    ],
    metricRows: [
      ...contiguousDailyRows("high", 3, 200), // cumulative through day 3: 800
      ...contiguousDailyRows("low", 3, 10), // cumulative through day 3: 40
      // "no_coverage" has no rows at all -- ageAlignedPerformanceValue stays null.
    ],
  });

  const result = await services.listAssetPerformance({
    channelId: "UC_A",
    performanceMetric: "views",
    performanceDayOffset: 3,
    credentialRef: { userId: "u1" },
    sort: "performanceMetric",
  });

  assert.deepEqual(result.assets.map((a) => a.assetId), ["high", "low", "no_coverage"]);
});

test("rejects sort performanceMetric without performanceMetric/performanceDayOffset being set", async () => {
  const { services } = createFixture({ assets: [] });

  await assert.rejects(
    () => services.listAssetPerformance({ channelId: "UC_A", sort: "performanceMetric" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("rejects performanceMetric without credentialRef", async () => {
  const { services } = createFixture({ assets: [] });

  await assert.rejects(
    () => services.listAssetPerformance({ channelId: "UC_A", performanceMetric: "views", performanceDayOffset: 3 }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

// AC-PERF-09
test("a limit above MAX_ASSET_PERFORMANCE_LIMIT is never rejected -- silently clamped, never an unbounded response", async () => {
  const { MAX_ASSET_PERFORMANCE_LIMIT } = await import("./schemas");
  const { services } = createFixture({
    assets: Array.from({ length: MAX_ASSET_PERFORMANCE_LIMIT + 10 }, (_, i) => asset({ assetId: `a${i}`, linkedVideoId: `v${i}` })),
    videos: Array.from({ length: MAX_ASSET_PERFORMANCE_LIMIT + 10 }, (_, i) => video({ videoId: `v${i}` })),
  });

  const result = await services.listAssetPerformance({ channelId: "UC_A", limit: MAX_ASSET_PERFORMANCE_LIMIT + 100 });

  assert.equal(result.assets.length, MAX_ASSET_PERFORMANCE_LIMIT);
  assert.equal(result.truncated, true);
});

// AC-PERF-10
test("performs no live YouTube call -- only the injected local dependencies are ever invoked", async () => {
  const { services } = createFixture({
    assets: [asset({ assetId: "a1", linkedVideoId: "v1" })],
    videos: [video({ videoId: "v1" })],
    metricRows: [{ videoId: "v1", metricDate: "2026-01-01", metricName: "views", metricValue: 1 }],
  });

  const result = await services.listAssetPerformance({
    channelId: "UC_A",
    performanceMetric: "views",
    performanceDayOffset: 0,
    credentialRef: { userId: "u1" },
  });

  assert.equal(result.assets.length, 1);
});

test("rejects an unexpected input field", async () => {
  const { services } = createFixture({ assets: [] });

  await assert.rejects(
    () => services.listAssetPerformance({ channelId: "UC_A", unexpected: true }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});
