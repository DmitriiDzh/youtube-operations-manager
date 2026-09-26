import assert from "node:assert/strict";
import test from "node:test";
import type { youtubeAnalytics_v2 } from "googleapis";
import { getAnalyticsReadsEnabled, setAnalyticsReadsEnabled } from "@/lib/db";
import { DomainError } from "@/lib/video-metadata/contracts";
import {
  assertAnalyticsReadsAuthorized,
  createYoutubeAnalyticsClient,
  queryChannelAnalyticsReport,
  queryChannelBreakdownReport,
  queryVideoAnalyticsReport,
} from "./analytics-api";

// The "Analytics reads" toggle (owner instruction, 2026-09-22): default-enabled, mirroring the
// Data API v3 toggle's own default (see data-api.test.ts's equivalent test).
test("assertAnalyticsReadsAuthorized / createYoutubeAnalyticsClient: default-enabled, throws analytics_reads_disabled when turned off", async () => {
  const alreadyEnabled = await getAnalyticsReadsEnabled();
  assert.equal(alreadyEnabled, true, "sanity check -- defaults to enabled, never reset on boot");

  await assertAnalyticsReadsAuthorized();
  await createYoutubeAnalyticsClient(undefined);

  await setAnalyticsReadsEnabled(false);
  try {
    await assert.rejects(
      () => assertAnalyticsReadsAuthorized(),
      (error: unknown) => error instanceof DomainError && error.code === "analytics_reads_disabled"
    );
    await assert.rejects(
      () => createYoutubeAnalyticsClient(undefined),
      (error: unknown) => error instanceof DomainError && error.code === "analytics_reads_disabled"
    );
  } finally {
    await setAnalyticsReadsEnabled(true);
  }
});

function fakeAnalyticsClient(
  reportsQuery: youtubeAnalytics_v2.Resource$Reports["query"]
): youtubeAnalytics_v2.Youtubeanalytics {
  return { reports: { query: reportsQuery } } as unknown as youtubeAnalytics_v2.Youtubeanalytics;
}

// AC (docs/roadmap/plans/PHASE_8_PLAN.md §7): the adapter's request-shaping is verified against
// a mocked real-shaped client, no real API call.
test("queryVideoAnalyticsReport sends ids/startDate/endDate/metrics/dimensions/filters exactly as specified", async () => {
  let capturedArgs: Record<string, unknown> | undefined;

  const youtubeAnalytics = fakeAnalyticsClient((async (args: Record<string, unknown>) => {
    capturedArgs = args;
    return { data: { columnHeaders: [], rows: [] } };
  }) as unknown as youtubeAnalytics_v2.Resource$Reports["query"]);

  await queryVideoAnalyticsReport(youtubeAnalytics, {
    channelId: "UC_TEST",
    videoId: "vid1",
    startDate: "2026-09-01",
    endDate: "2026-09-20",
    metricNames: ["views", "likes"],
  });

  assert.equal(capturedArgs?.ids, "channel==UC_TEST");
  assert.equal(capturedArgs?.startDate, "2026-09-01");
  assert.equal(capturedArgs?.endDate, "2026-09-20");
  assert.equal(capturedArgs?.metrics, "views,likes");
  assert.equal(capturedArgs?.dimensions, "day");
  assert.equal(capturedArgs?.filters, "video==vid1");
});

test("queryVideoAnalyticsReport maps rows by column name, never by position", async () => {
  // Deliberately reordered relative to the request (metrics before the day dimension) to prove
  // the mapping is name-based, not "day is always column 0" -- the exact assumption that would
  // silently corrupt data if the API's own documented ordering guarantee were ever wrong, stale,
  // or misread.
  const youtubeAnalytics = fakeAnalyticsClient((async () => ({
    data: {
      columnHeaders: [
        { columnType: "METRIC", dataType: "INTEGER", name: "likes" },
        { columnType: "METRIC", dataType: "INTEGER", name: "views" },
        { columnType: "DIMENSION", dataType: "STRING", name: "day" },
      ],
      rows: [
        [5, 100, "2026-09-01"],
        [7, 150, "2026-09-02"],
      ],
    },
  })) as unknown as youtubeAnalytics_v2.Resource$Reports["query"]);

  const rows = await queryVideoAnalyticsReport(youtubeAnalytics, {
    channelId: "UC_TEST",
    videoId: "vid1",
    startDate: "2026-09-01",
    endDate: "2026-09-02",
    metricNames: ["likes", "views"],
  });

  assert.deepEqual(rows, [
    { date: "2026-09-01", metrics: { likes: 5, views: 100 } },
    { date: "2026-09-02", metrics: { likes: 7, views: 150 } },
  ]);
});

// AC (docs/roadmap/plans/PHASE_8_PLAN.md §7): idempotent, well-defined behavior for the "no data
// yet for this range" case -- per the official Schema$QueryResponse docs, `rows` is OMITTED
// entirely (not an empty array) when there is no data, so this also proves that case is handled.
test("queryVideoAnalyticsReport returns an empty array when the API response omits rows entirely", async () => {
  const youtubeAnalytics = fakeAnalyticsClient((async () => ({
    data: {
      columnHeaders: [
        { columnType: "DIMENSION", dataType: "STRING", name: "day" },
        { columnType: "METRIC", dataType: "INTEGER", name: "views" },
      ],
      // rows intentionally absent
    },
  })) as unknown as youtubeAnalytics_v2.Resource$Reports["query"]);

  const rows = await queryVideoAnalyticsReport(youtubeAnalytics, {
    channelId: "UC_TEST",
    videoId: "vid1",
    startDate: "2026-09-01",
    endDate: "2026-09-02",
    metricNames: ["views"],
  });

  assert.deepEqual(rows, []);
});

test("queryVideoAnalyticsReport throws rather than emit a blank metric_date if rows exist with no 'day' column", async () => {
  const youtubeAnalytics = fakeAnalyticsClient((async () => ({
    data: {
      columnHeaders: [{ columnType: "METRIC", dataType: "INTEGER", name: "views" }],
      rows: [[100]],
    },
  })) as unknown as youtubeAnalytics_v2.Resource$Reports["query"]);

  await assert.rejects(() =>
    queryVideoAnalyticsReport(youtubeAnalytics, {
      channelId: "UC_TEST",
      videoId: "vid1",
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      metricNames: ["views"],
    })
  );
});

test("queryVideoAnalyticsReport handles a fractional metric value exactly", async () => {
  const youtubeAnalytics = fakeAnalyticsClient((async () => ({
    data: {
      columnHeaders: [
        { columnType: "DIMENSION", dataType: "STRING", name: "day" },
        { columnType: "METRIC", dataType: "FLOAT", name: "averageViewPercentage" },
      ],
      rows: [["2026-09-01", 63.75]],
    },
  })) as unknown as youtubeAnalytics_v2.Resource$Reports["query"]);

  const rows = await queryVideoAnalyticsReport(youtubeAnalytics, {
    channelId: "UC_TEST",
    videoId: "vid1",
    startDate: "2026-09-01",
    endDate: "2026-09-01",
    metricNames: ["averageViewPercentage"],
  });

  assert.deepEqual(rows, [{ date: "2026-09-01", metrics: { averageViewPercentage: 63.75 } }]);
});

// Studio-Parity S6b -- channel-level report has no `filters=video==...`, unlike the per-video
// report above. Live-verified 2026-09-23 that the real API accepts this shape (see
// `queryChannelAnalyticsReport`'s own doc comment); this test only verifies the request is shaped
// as that live probe confirmed, not the live API itself.
test("queryChannelAnalyticsReport sends ids/startDate/endDate/metrics/dimensions with no video filter", async () => {
  let capturedArgs: Record<string, unknown> | undefined;

  const youtubeAnalytics = fakeAnalyticsClient((async (args: Record<string, unknown>) => {
    capturedArgs = args;
    return { data: { columnHeaders: [], rows: [] } };
  }) as unknown as youtubeAnalytics_v2.Resource$Reports["query"]);

  await queryChannelAnalyticsReport(youtubeAnalytics, {
    channelId: "UC_TEST",
    startDate: "2026-08-26",
    endDate: "2026-09-22",
    metricNames: ["views", "subscribersGained"],
  });

  assert.equal(capturedArgs?.ids, "channel==UC_TEST");
  assert.equal(capturedArgs?.startDate, "2026-08-26");
  assert.equal(capturedArgs?.endDate, "2026-09-22");
  assert.equal(capturedArgs?.metrics, "views,subscribersGained");
  assert.equal(capturedArgs?.dimensions, "day");
  assert.equal("filters" in (capturedArgs ?? {}), false);
});

test("queryChannelAnalyticsReport maps rows by column name, matching the real live-verified response shape", async () => {
  const youtubeAnalytics = fakeAnalyticsClient((async () => ({
    data: {
      // Exact shape returned by the real API for a channel-level probe against "Tropico Jazz"
      // (2026-09-23), reordered here the same way the per-video test above does, to prove
      // name-based mapping.
      columnHeaders: [
        { name: "day", columnType: "DIMENSION", dataType: "STRING" },
        { name: "views", columnType: "METRIC", dataType: "INTEGER" },
        { name: "estimatedMinutesWatched", columnType: "METRIC", dataType: "INTEGER" },
        { name: "subscribersGained", columnType: "METRIC", dataType: "INTEGER" },
        { name: "subscribersLost", columnType: "METRIC", dataType: "INTEGER" },
      ],
      rows: [["2026-08-26", 175, 2946, 3, 1]],
    },
  })) as unknown as youtubeAnalytics_v2.Resource$Reports["query"]);

  const rows = await queryChannelAnalyticsReport(youtubeAnalytics, {
    channelId: "UC_TEST",
    startDate: "2026-08-26",
    endDate: "2026-08-26",
    metricNames: ["views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost"],
  });

  assert.deepEqual(rows, [
    {
      date: "2026-08-26",
      metrics: { views: 175, estimatedMinutesWatched: 2946, subscribersGained: 3, subscribersLost: 1 },
    },
  ]);
});

// Independent review round 2 (2026-09-26) found `queryChannelBreakdownReport`'s own response-
// parsing (multi-dimension `dimensionValues` ordering, `filters` spread) was only ever exercised
// indirectly, one layer up, through fixture-mocked services tests -- direct tests added here,
// mirroring the direct-adapter-test pattern the two functions above already use.
// docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §1/§3.4/§4.4.
test("queryChannelBreakdownReport sends ids/startDate/endDate/metrics/dimensions with no filters when none given", async () => {
  let capturedArgs: Record<string, unknown> | undefined;

  const youtubeAnalytics = fakeAnalyticsClient((async (args: Record<string, unknown>) => {
    capturedArgs = args;
    return { data: { columnHeaders: [], rows: [] } };
  }) as unknown as youtubeAnalytics_v2.Resource$Reports["query"]);

  await queryChannelBreakdownReport(youtubeAnalytics, {
    channelId: "UC_TEST",
    startDate: "2026-08-26",
    endDate: "2026-09-22",
    dimensions: "insightTrafficSourceType",
    metricNames: ["views"],
  });

  assert.equal(capturedArgs?.ids, "channel==UC_TEST");
  assert.equal(capturedArgs?.startDate, "2026-08-26");
  assert.equal(capturedArgs?.endDate, "2026-09-22");
  assert.equal(capturedArgs?.metrics, "views");
  assert.equal(capturedArgs?.dimensions, "insightTrafficSourceType");
  assert.equal("filters" in (capturedArgs ?? {}), false);
});

test("queryChannelBreakdownReport passes filters through exactly when given (the per-video retention-curve shape)", async () => {
  let capturedArgs: Record<string, unknown> | undefined;

  const youtubeAnalytics = fakeAnalyticsClient((async (args: Record<string, unknown>) => {
    capturedArgs = args;
    return { data: { columnHeaders: [], rows: [] } };
  }) as unknown as youtubeAnalytics_v2.Resource$Reports["query"]);

  await queryChannelBreakdownReport(youtubeAnalytics, {
    channelId: "UC_TEST",
    startDate: "2026-08-26",
    endDate: "2026-09-22",
    dimensions: "elapsedVideoTimeRatio",
    metricNames: ["audienceWatchRatio", "relativeRetentionPerformance"],
    filters: "video==vid1",
  });

  assert.equal(capturedArgs?.dimensions, "elapsedVideoTimeRatio");
  assert.equal(capturedArgs?.filters, "video==vid1");
});

test("queryChannelBreakdownReport maps a single dimension's values, matching the real live-verified traffic-source response shape", async () => {
  const youtubeAnalytics = fakeAnalyticsClient((async () => ({
    data: {
      // Real shape observed for insightTrafficSourceType against "Tropico Jazz" (2026-09-25 probe).
      columnHeaders: [
        { name: "insightTrafficSourceType", columnType: "DIMENSION", dataType: "STRING" },
        { name: "views", columnType: "METRIC", dataType: "INTEGER" },
      ],
      rows: [
        ["RELATED_VIDEO", 3462],
        ["YT_SEARCH", 90],
      ],
    },
  })) as unknown as youtubeAnalytics_v2.Resource$Reports["query"]);

  const rows = await queryChannelBreakdownReport(youtubeAnalytics, {
    channelId: "UC_TEST",
    startDate: "2026-08-28",
    endDate: "2026-09-23",
    dimensions: "insightTrafficSourceType",
    metricNames: ["views"],
  });

  assert.deepEqual(rows, [
    { dimensionValues: ["RELATED_VIDEO"], metrics: { views: 3462 } },
    { dimensionValues: ["YT_SEARCH"], metrics: { views: 90 } },
  ]);
});

test("queryChannelBreakdownReport maps a multi-dimension response in request order (ageGroup,gender)", async () => {
  const youtubeAnalytics = fakeAnalyticsClient((async () => ({
    data: {
      columnHeaders: [
        { name: "ageGroup", columnType: "DIMENSION", dataType: "STRING" },
        { name: "gender", columnType: "DIMENSION", dataType: "STRING" },
        { name: "viewerPercentage", columnType: "METRIC", dataType: "FLOAT" },
      ],
      rows: [["age65-", "male", 53.9]],
    },
  })) as unknown as youtubeAnalytics_v2.Resource$Reports["query"]);

  const rows = await queryChannelBreakdownReport(youtubeAnalytics, {
    channelId: "UC_TEST",
    startDate: "2026-08-28",
    endDate: "2026-09-23",
    dimensions: "ageGroup,gender",
    metricNames: ["viewerPercentage"],
  });

  assert.deepEqual(rows, [{ dimensionValues: ["age65-", "male"], metrics: { viewerPercentage: 53.9 } }]);
});

test("queryChannelBreakdownReport returns an empty array when the API response omits rows entirely", async () => {
  const youtubeAnalytics = fakeAnalyticsClient((async () => ({
    data: {
      columnHeaders: [
        { name: "deviceType", columnType: "DIMENSION", dataType: "STRING" },
        { name: "estimatedMinutesWatched", columnType: "METRIC", dataType: "INTEGER" },
      ],
      // rows intentionally absent
    },
  })) as unknown as youtubeAnalytics_v2.Resource$Reports["query"]);

  const rows = await queryChannelBreakdownReport(youtubeAnalytics, {
    channelId: "UC_TEST",
    startDate: "2026-08-28",
    endDate: "2026-09-23",
    dimensions: "deviceType",
    metricNames: ["estimatedMinutesWatched"],
  });

  assert.deepEqual(rows, []);
});
