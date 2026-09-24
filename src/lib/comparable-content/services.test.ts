import assert from "node:assert/strict";
import test from "node:test";
import { createComparableContentServices, type VideoRecordForComparison } from "./services";
import { DomainError } from "./contracts";

function video(overrides: Partial<VideoRecordForComparison> & { videoId: string }): VideoRecordForComparison {
  return {
    title: "Untitled",
    publishedAt: "2026-01-01T00:00:00.000Z",
    durationSeconds: null,
    ...overrides,
  };
}

function createFixture(
  overrides: Partial<{
    videos: VideoRecordForComparison[];
    metricRows: Array<{ videoId: string; metricDate: string; metricName: string; metricValue: number }>;
    now: Date;
  }> = {}
) {
  const listMetricsCalls: unknown[] = [];
  const services = createComparableContentServices({
    listVideosByChannel: async () => overrides.videos ?? [],
    listMetrics: async (input) => {
      listMetricsCalls.push(input);
      return { channelId: "UC_A", rows: overrides.metricRows ?? [] };
    },
    now: () => overrides.now ?? new Date("2026-06-01T00:00:00.000Z"),
  });
  return { services, listMetricsCalls };
}

// AC-CMP-01
test("returns other videos from the same channel, excluding the anchor itself", async () => {
  const { services } = createFixture({
    videos: [
      video({ videoId: "anchor", title: "Anchor" }),
      video({ videoId: "v1", title: "Video One" }),
      video({ videoId: "v2", title: "Video Two" }),
    ],
  });

  const result = await services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "publicationProximity" });

  assert.equal(result.anchorVideoId, "anchor");
  assert.deepEqual(
    result.candidates.map((c) => c.videoId).sort(),
    ["v1", "v2"]
  );
  assert.equal(result.anchor.videoId, "anchor");
  assert.equal(result.anchor.title, "Anchor");
  assert.equal(result.performanceAlignment, null);
});

// AC-CMP-02
test("throws DATA_NOT_SYNCED for an anchorVideoId that does not belong to the requested channel", async () => {
  const { services } = createFixture({ videos: [video({ videoId: "v1" })] });

  await assert.rejects(
    () => services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "nonexistent", sort: "publicationProximity" }),
    (error: unknown) => error instanceof DomainError && error.code === "DATA_NOT_SYNCED"
  );
});

// AC-CMP-03
test("publicationWindowDays excludes candidates outside the window, in either direction", async () => {
  const { services } = createFixture({
    videos: [
      video({ videoId: "anchor", publishedAt: "2026-06-01T00:00:00.000Z" }),
      video({ videoId: "within_before", publishedAt: "2026-05-25T00:00:00.000Z" }), // 7 days before
      video({ videoId: "within_after", publishedAt: "2026-06-08T00:00:00.000Z" }), // 7 days after
      video({ videoId: "outside", publishedAt: "2026-07-01T00:00:00.000Z" }), // 30 days after
    ],
  });

  const result = await services.findComparableVideos({
    channelId: "UC_A",
    anchorVideoId: "anchor",
    publicationWindowDays: 7,
    sort: "publicationProximity",
  });

  assert.deepEqual(
    result.candidates.map((c) => c.videoId).sort(),
    ["within_after", "within_before"]
  );
});

// AC-CMP-04
test("durationToleranceSeconds excludes a candidate with no known duration and counts it in excludedForMissingData.duration", async () => {
  const { services } = createFixture({
    videos: [
      video({ videoId: "anchor", durationSeconds: 600 }),
      video({ videoId: "close", durationSeconds: 620 }),
      video({ videoId: "far", durationSeconds: 6000 }),
      video({ videoId: "unknown_duration", durationSeconds: null }),
    ],
  });

  const result = await services.findComparableVideos({
    channelId: "UC_A",
    anchorVideoId: "anchor",
    durationToleranceSeconds: 60,
    sort: "publicationProximity",
  });

  assert.deepEqual(result.candidates.map((c) => c.videoId), ["close"]);
  assert.equal(result.excludedForMissingData.duration, 1);
});

test("durationToleranceSeconds fails the whole request with INVALID_CONTEXT_REQUEST when the anchor itself has no known duration", async () => {
  const { services } = createFixture({
    videos: [video({ videoId: "anchor", durationSeconds: null }), video({ videoId: "v1", durationSeconds: 600 })],
  });

  await assert.rejects(
    () =>
      services.findComparableVideos({
        channelId: "UC_A",
        anchorVideoId: "anchor",
        durationToleranceSeconds: 60,
        sort: "publicationProximity",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_CONTEXT_REQUEST"
  );
});

// `computeComparableAgeSeries` (reused unchanged, AGENTS.md §D) only reports a cumulative point
// at a given day-offset if every earlier day back to 0 also has a row -- it never zero-fills a
// gap (`comparable-age.ts`'s own documented, accepted behavior). These fixtures provide
// CONTIGUOUS daily rows from day 0 through the comparison day for every video expected to have
// coverage, matching what a real, regularly-collected channel's analytics actually look like.
function contiguousDailyRows(videoId: string, days: number, valuePerDay: number) {
  const rows: Array<{ videoId: string; metricDate: string; metricName: string; metricValue: number }> = [];
  for (let offset = 0; offset <= days; offset += 1) {
    const date = new Date(Date.UTC(2026, 4, 1 + offset)); // 2026-05-01 + offset days
    rows.push({ videoId, metricDate: date.toISOString().slice(0, 10), metricName: "views", metricValue: valuePerDay });
  }
  return rows;
}

// AC-CMP-05
test("performanceThreshold is evaluated age-aligned against the anchor's current age, excluding candidates with no coverage at that age", async () => {
  const { services, listMetricsCalls } = createFixture({
    videos: [
      video({ videoId: "anchor", publishedAt: "2026-05-01T20:00:00.000Z" }),
      // Published the same day as the anchor -- 3 days old at comparison time, same as the anchor.
      video({ videoId: "passes", publishedAt: "2026-05-01T20:00:00.000Z" }),
      // Too young to have data at day 3 (published on the comparison day itself).
      video({ videoId: "too_young", publishedAt: "2026-05-04T20:00:00.000Z" }),
      // Old enough, but below the threshold.
      video({ videoId: "below_threshold", publishedAt: "2026-05-01T20:00:00.000Z" }),
    ],
    // "now" is 2026-05-04 -- the anchor (published 2026-05-01) is 3 days old at comparison time.
    metricRows: [
      ...contiguousDailyRows("passes", 3, 200), // cumulative through day 3: 800 >= 500
      ...contiguousDailyRows("below_threshold", 3, 1), // cumulative through day 3: 4, below 500
      // "too_young" has no rows at all -- genuinely no coverage.
    ],
    now: new Date("2026-05-04T20:00:00.000Z"),
  });

  const result = await services.findComparableVideos({
    channelId: "UC_A",
    anchorVideoId: "anchor",
    performanceMetric: "views",
    performanceThreshold: { operator: ">=", value: 500 },
    credentialRef: { userId: "u1" },
    sort: "publicationProximity",
  });

  assert.deepEqual(result.candidates.map((c) => c.videoId), ["passes"]);
  assert.equal(result.excludedForMissingData.performance, 1); // "too_young"
  assert.equal(listMetricsCalls.length, 1);
  assert.deepEqual(listMetricsCalls[0], { credentialRef: { userId: "u1" }, channelId: "UC_A", metricNames: ["views"] });
  assert.deepEqual(result.performanceAlignment, { metricName: "views", dayOffset: 3 });
  // The anchor itself has no metric rows in this fixture -- its own reference value is honestly
  // null, never fabricated, exactly like a candidate with no coverage at that age.
  assert.equal(result.anchor.performanceMetricValue, null);
});

test("performanceMetric without a threshold still reports the raw metric value, never a fabricated one, and never excludes based on it", async () => {
  const { services } = createFixture({
    videos: [video({ videoId: "anchor", publishedAt: "2026-05-01T20:00:00.000Z" }), video({ videoId: "v1", publishedAt: "2026-05-01T20:00:00.000Z" })],
    metricRows: [...contiguousDailyRows("v1", 3, 6), ...contiguousDailyRows("anchor", 3, 10)],
    now: new Date("2026-05-04T20:00:00.000Z"),
  });

  const result = await services.findComparableVideos({
    channelId: "UC_A",
    anchorVideoId: "anchor",
    performanceMetric: "views",
    credentialRef: { userId: "u1" },
    sort: "performanceMetric",
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].performanceMetricValue, 24); // cumulative through day 3 (4 days * 6)
  assert.equal(result.anchor.performanceMetricValue, 40); // cumulative through day 3 (4 days * 10)
  assert.deepEqual(result.performanceAlignment, { metricName: "views", dayOffset: 3 });
});

test("listMetrics is never called when performanceMetric is not requested (no unnecessary analytics read)", async () => {
  const { services, listMetricsCalls } = createFixture({
    videos: [video({ videoId: "anchor" }), video({ videoId: "v1" })],
  });

  await services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "publicationProximity" });

  assert.equal(listMetricsCalls.length, 0);
});

// AC-CMP-06
test("sort modes are explicit and each reports the raw comparison facts behind the requested mode, never a single opaque score", async () => {
  const { services } = createFixture({
    videos: [
      video({ videoId: "anchor", title: "Cuban Jazz Cafe Sunny", durationSeconds: 600, publishedAt: "2026-06-01T00:00:00.000Z" }),
      video({ videoId: "near_date", title: "Unrelated", durationSeconds: 6000, publishedAt: "2026-06-02T00:00:00.000Z" }),
      video({ videoId: "near_duration", title: "Unrelated Two", durationSeconds: 610, publishedAt: "2026-01-01T00:00:00.000Z" }),
      video({ videoId: "shared_tokens", title: "Cuban Jazz Rainy", durationSeconds: 99999, publishedAt: "2026-01-01T00:00:00.000Z" }),
    ],
  });

  const byDate = await services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "publicationProximity" });
  assert.equal(byDate.candidates[0].videoId, "near_date");

  const byDuration = await services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "durationProximity" });
  assert.equal(byDuration.candidates[0].videoId, "near_duration");

  const byTokens = await services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "titleTokenOverlap" });
  assert.equal(byTokens.candidates[0].videoId, "shared_tokens");
  assert.deepEqual(byTokens.candidates[0].sharedTitleTokens, ["cuban", "jazz"]);
});

// AC-CMP-07
test("limit caps the result set and reports truncated: true", async () => {
  const { services } = createFixture({
    videos: [
      video({ videoId: "anchor" }),
      video({ videoId: "v1" }),
      video({ videoId: "v2" }),
      video({ videoId: "v3" }),
    ],
  });

  const result = await services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "publicationProximity", limit: 2 });

  assert.equal(result.candidates.length, 2);
  assert.equal(result.truncated, true);
});

test("no truncation when every candidate fits within the limit", async () => {
  const { services } = createFixture({
    videos: [video({ videoId: "anchor" }), video({ videoId: "v1" })],
  });

  const result = await services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "publicationProximity", limit: 20 });

  assert.equal(result.truncated, false);
});

// AC-CMP-08
test("performs no live YouTube call -- only the injected local dependencies are ever invoked", async () => {
  // The fixture's own listVideosByChannel/listMetrics are pure in-memory fakes with no YouTube
  // client of any kind -- a successful call here IS the proof there is no live-call code path.
  const { services } = createFixture({
    videos: [video({ videoId: "anchor", publishedAt: "2026-05-01T20:00:00.000Z" }), video({ videoId: "v1", publishedAt: "2026-05-01T20:00:00.000Z" })],
    metricRows: [{ videoId: "v1", metricDate: "2026-05-01", metricName: "views", metricValue: 1 }],
  });

  const result = await services.findComparableVideos({
    channelId: "UC_A",
    anchorVideoId: "anchor",
    performanceMetric: "views",
    credentialRef: { userId: "u1" },
    sort: "publicationProximity",
  });

  assert.equal(result.candidates.length, 1);
});

test("rejects an unexpected input field", async () => {
  const { services } = createFixture({ videos: [video({ videoId: "anchor" })] });

  await assert.rejects(
    () => services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "publicationProximity", unexpected: true }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("rejects performanceThreshold without performanceMetric", async () => {
  const { services } = createFixture({ videos: [video({ videoId: "anchor" })] });

  await assert.rejects(
    () =>
      services.findComparableVideos({
        channelId: "UC_A",
        anchorVideoId: "anchor",
        performanceThreshold: { operator: ">=", value: 1 },
        sort: "publicationProximity",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("rejects sort performanceMetric without performanceMetric being set", async () => {
  const { services } = createFixture({ videos: [video({ videoId: "anchor" })] });

  await assert.rejects(
    () => services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "performanceMetric" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("rejects performanceMetric without credentialRef", async () => {
  const { services } = createFixture({ videos: [video({ videoId: "anchor" })] });

  await assert.rejects(
    () => services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", performanceMetric: "views", sort: "performanceMetric" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});
