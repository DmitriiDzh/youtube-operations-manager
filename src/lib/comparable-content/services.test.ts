import assert from "node:assert/strict";
import test from "node:test";
import { createComparableContentServices, type VideoRecordForComparison } from "./services";
import { DomainError } from "./contracts";
import { MAX_COMPARABLE_VIDEOS_LIMIT } from "./schemas";

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

test("durationToleranceSeconds includes a candidate exactly AT the tolerance boundary (inclusive, \"more than\" excludes, not \"at least\")", async () => {
  const { services } = createFixture({
    videos: [
      video({ videoId: "anchor", durationSeconds: 600 }),
      video({ videoId: "exactly_at_tolerance", durationSeconds: 660 }), // distance 60, tolerance 60
      video({ videoId: "just_over_tolerance", durationSeconds: 661 }), // distance 61, tolerance 60
    ],
  });

  const result = await services.findComparableVideos({
    channelId: "UC_A",
    anchorVideoId: "anchor",
    durationToleranceSeconds: 60,
    sort: "publicationProximity",
  });

  assert.deepEqual(result.candidates.map((c) => c.videoId), ["exactly_at_tolerance"]);
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

test("sort durationProximity without durationToleranceSeconds still fails with INVALID_CONTEXT_REQUEST when the anchor has no known duration (never an arbitrary/NaN-driven order)", async () => {
  const { services } = createFixture({
    videos: [video({ videoId: "anchor", durationSeconds: null }), video({ videoId: "v1", durationSeconds: 600 })],
  });

  await assert.rejects(
    () => services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "durationProximity" }),
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
test("performanceThreshold is evaluated age-aligned against the furthest day the ANCHOR's own data actually reaches -- never wall-clock 'now' -- excluding candidates with no coverage at that day", async () => {
  const { services, listMetricsCalls } = createFixture({
    videos: [
      video({ videoId: "anchor", publishedAt: "2026-05-01T20:00:00.000Z" }),
      // Published the same day as the anchor.
      video({ videoId: "passes", publishedAt: "2026-05-01T20:00:00.000Z" }),
      // Too young to have data at day 3 (published on the anchor's own last-collected day itself).
      video({ videoId: "too_young", publishedAt: "2026-05-04T20:00:00.000Z" }),
      // Old enough, but below the threshold.
      video({ videoId: "below_threshold", publishedAt: "2026-05-01T20:00:00.000Z" }),
    ],
    // The anchor's OWN collected data only reaches day 3 -- "now" is deliberately much later
    // (day 20) to prove alignment is derived from the anchor's actual data coverage, not from
    // wall-clock age: real analytics collection intentionally never reaches "today"
    // (`staleness.ts`'s own default collection range ends at yesterday), so picking "now" as the
    // comparison day would leave a recently-published anchor with no data at all yet -- this is
    // the exact bug an earlier version of this service had (found by independent review).
    metricRows: [
      ...contiguousDailyRows("anchor", 3, 5), // cumulative through day 3: 20
      ...contiguousDailyRows("passes", 3, 200), // cumulative through day 3: 800 >= 500
      ...contiguousDailyRows("below_threshold", 3, 1), // cumulative through day 3: 4, below 500
      // "too_young" has no rows at all -- genuinely no coverage.
    ],
    now: new Date("2026-05-21T20:00:00.000Z"),
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
  assert.equal(result.anchor.performanceMetricValue, 20);
});

// Distinct from the fixture above: an OLD anchor (published long before "now") whose own day-0/
// day-1 were never collected (this channel's regular collection started only later) but which DOES
// have real data at later days -- `analytics_comparable_age`'s own tool description documents this
// exact situation as a normal, common data-coverage limitation for an existing channel, not an
// error. `computeComparableAgeSeries`'s "contiguous from day 0" rule means this anchor's later data
// NEVER contributes a cumulative point, so it degrades to day 0 exactly like a brand-new anchor
// with zero data -- but `performanceThreshold` is an ABSOLUTE comparison (never relative to the
// anchor's own value), so a candidate with genuine day-0 coverage can still correctly pass.
test("an old anchor with real data at later days but no day-0 coverage still lets a candidate with real day-0 data pass an absolute performanceThreshold, even though the anchor's own value is honestly null", async () => {
  const { services } = createFixture({
    videos: [
      video({ videoId: "anchor", publishedAt: "2026-01-01T20:00:00.000Z" }),
      video({ videoId: "passes", publishedAt: "2026-05-01T20:00:00.000Z" }),
    ],
    metricRows: [
      // Anchor's day 0/day 1 were never collected -- day 2 onward has real data, but that never
      // contributes a cumulative point without day 0 itself.
      { videoId: "anchor", metricDate: "2026-01-03", metricName: "views", metricValue: 999 },
      { videoId: "anchor", metricDate: "2026-01-04", metricName: "views", metricValue: 999 },
      // "passes" has genuine day-0 coverage (recently published, actively collected channel).
      { videoId: "passes", metricDate: "2026-05-01", metricName: "views", metricValue: 600 },
    ],
    now: new Date("2026-06-01T20:00:00.000Z"),
  });

  const result = await services.findComparableVideos({
    channelId: "UC_A",
    anchorVideoId: "anchor",
    performanceMetric: "views",
    performanceThreshold: { operator: ">=", value: 500 },
    credentialRef: { userId: "u1" },
    sort: "publicationProximity",
  });

  assert.deepEqual(result.performanceAlignment, { metricName: "views", dayOffset: 0 });
  assert.equal(result.anchor.performanceMetricValue, null);
  assert.deepEqual(result.candidates.map((c) => c.videoId), ["passes"]);
  assert.equal(result.excludedForMissingData.performance, 0);
});

test("performanceThreshold operators are inclusive at the exact boundary value (>= and <=, never strict > / <)", async () => {
  const { services } = createFixture({
    videos: [
      video({ videoId: "anchor", publishedAt: "2026-05-01T20:00:00.000Z" }),
      video({ videoId: "exactly_at_threshold", publishedAt: "2026-05-01T20:00:00.000Z" }),
    ],
    metricRows: contiguousDailyRows("exactly_at_threshold", 0, 500), // day 0 cumulative: exactly 500
    now: new Date("2026-05-01T20:00:00.000Z"),
  });

  const gte = await services.findComparableVideos({
    channelId: "UC_A",
    anchorVideoId: "anchor",
    performanceMetric: "views",
    performanceThreshold: { operator: ">=", value: 500 },
    credentialRef: { userId: "u1" },
    sort: "publicationProximity",
  });
  assert.deepEqual(gte.candidates.map((c) => c.videoId), ["exactly_at_threshold"]);

  const lte = await services.findComparableVideos({
    channelId: "UC_A",
    anchorVideoId: "anchor",
    performanceMetric: "views",
    performanceThreshold: { operator: "<=", value: 500 },
    credentialRef: { userId: "u1" },
    sort: "publicationProximity",
  });
  assert.deepEqual(lte.candidates.map((c) => c.videoId), ["exactly_at_threshold"]);
});

test("degrades to day 0 when the anchor has no collected data at all yet, rather than an arbitrary later day nobody has data for either", async () => {
  const { services } = createFixture({
    videos: [video({ videoId: "anchor", publishedAt: "2026-05-01T20:00:00.000Z" }), video({ videoId: "v1", publishedAt: "2026-05-01T20:00:00.000Z" })],
    metricRows: [], // no data at all, not even day 0, for anyone
    now: new Date("2026-05-21T20:00:00.000Z"),
  });

  const result = await services.findComparableVideos({
    channelId: "UC_A",
    anchorVideoId: "anchor",
    performanceMetric: "views",
    credentialRef: { userId: "u1" },
    sort: "performanceMetric",
  });

  assert.deepEqual(result.performanceAlignment, { metricName: "views", dayOffset: 0 });
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

test("sort durationProximity still works when the anchor's duration is known but some candidates' own duration is not -- those sort to the back, never crash or reorder arbitrarily", async () => {
  const { services } = createFixture({
    videos: [
      video({ videoId: "anchor", durationSeconds: 600 }),
      video({ videoId: "close", durationSeconds: 610 }), // distance 10
      video({ videoId: "unknown_duration", durationSeconds: null }), // distance null -> Infinity
      video({ videoId: "far", durationSeconds: 6000 }), // distance 5400
    ],
  });

  const result = await services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "durationProximity" });

  assert.deepEqual(result.candidates.map((c) => c.videoId), ["close", "far", "unknown_duration"]);
  assert.equal(result.candidates.find((c) => c.videoId === "unknown_duration")!.durationDistanceSeconds, null);
});

test("sharedTitleTokens handles non-Latin titles (e.g. Cyrillic), not just ASCII (this app's own localization focus makes non-Latin titles a realistic case)", async () => {
  const { services } = createFixture({
    videos: [
      video({ videoId: "anchor", title: "Обзор нового телефона" }),
      video({ videoId: "match", title: "Обзор старого телефона" }),
      video({ videoId: "nomatch", title: "Совершенно другое видео" }),
    ],
  });

  const result = await services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "titleTokenOverlap" });

  const match = result.candidates.find((c) => c.videoId === "match");
  assert.ok(match);
  assert.deepEqual(match!.sharedTitleTokens.sort(), ["обзор", "телефона"]);
  const nomatch = result.candidates.find((c) => c.videoId === "nomatch");
  assert.deepEqual(nomatch!.sharedTitleTokens, []);
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

// Found by independent review (round 3): a caller-supplied `limit` above MAX_COMPARABLE_VIDEOS_LIMIT
// used to be REJECTED as validation_failed by the schema -- contradicting this capability's own
// documented "never an unbounded response, always silently capped with truncated: true" contract
// (AC-CMP-07). Never a schema-level rejection; always a silent server-side clamp.
test("a limit above MAX_COMPARABLE_VIDEOS_LIMIT is never rejected -- silently clamped to it, never an unbounded response", async () => {
  const { services } = createFixture({
    videos: [
      video({ videoId: "anchor" }),
      ...Array.from({ length: MAX_COMPARABLE_VIDEOS_LIMIT + 10 }, (_, i) => video({ videoId: `v${i}` })),
    ],
  });

  const result = await services.findComparableVideos({
    channelId: "UC_A",
    anchorVideoId: "anchor",
    sort: "publicationProximity",
    limit: MAX_COMPARABLE_VIDEOS_LIMIT + 100,
  });

  assert.equal(result.candidates.length, MAX_COMPARABLE_VIDEOS_LIMIT);
  assert.equal(result.truncated, true);
});

// AC-CMP-08. This test alone is NOT sufficient proof (fixtures with no YouTube client would
// "pass" this even if a live call existed elsewhere in the module) -- the real evidence is
// architectural: `src/lib/comparable-content/` imports neither `googleapis` nor
// `youtube-read-gateway` anywhere (confirmed by reading the module). This test only demonstrates
// that the injected local fakes are sufficient for a full request to succeed.
test("performs no live YouTube call -- only the injected local dependencies are ever invoked", async () => {
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

// Robustness guard (found by independent review, round 3): `videos.published_at` is NOT NULL but
// not empty-string-constrained, and the sync path can theoretically persist "" if YouTube ever
// omits `snippet.publishedAt`. Neither case has been observed in real data -- this only proves one
// bad row can't crash the whole request or poison every other candidate's comparison.
test("fails the whole request with INVALID_CONTEXT_REQUEST when the anchor itself has a malformed publishedAt", async () => {
  const { services } = createFixture({
    videos: [video({ videoId: "anchor", publishedAt: "" }), video({ videoId: "v1" })],
  });

  await assert.rejects(
    () => services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "publicationProximity" }),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_CONTEXT_REQUEST"
  );
});

test("excludes a candidate with a malformed publishedAt rather than failing the whole request", async () => {
  const { services } = createFixture({
    videos: [
      video({ videoId: "anchor" }),
      video({ videoId: "malformed", publishedAt: "" }),
      video({ videoId: "fine", publishedAt: "2026-01-05T00:00:00.000Z" }),
    ],
  });

  const result = await services.findComparableVideos({ channelId: "UC_A", anchorVideoId: "anchor", sort: "publicationProximity" });

  assert.deepEqual(result.candidates.map((c) => c.videoId), ["fine"]);
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
