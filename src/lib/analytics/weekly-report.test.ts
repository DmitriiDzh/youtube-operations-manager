import assert from "node:assert/strict";
import test from "node:test";
import { computeDueReportWeek, computeWeeklyReportContent } from "./weekly-report";

// Every expected value below was independently hand-computed against real calendar facts
// (2026-09-21/2026-09-28/2026-12-28/2027-01-04 are Mondays; DST in America/Los_Angeles falls back
// on 2026-11-01) before running the implementation, per AGENTS.md §L.

test("computeDueReportWeek: Monday before the local boundary time steps back to the PRIOR week", () => {
  // 2026-09-21 is a Monday. 09:00 UTC is before the 12:05 boundary, so the boundary for THIS
  // Monday has not passed yet -- the due report is still for the week before last.
  const result = computeDueReportWeek({
    now: new Date("2026-09-21T09:00:00Z"),
    timezone: "UTC",
    localTime: "12:05",
  });
  assert.deepEqual(result, { weekStartDate: "2026-09-07", weekEndDate: "2026-09-13" });
});

test("computeDueReportWeek: Monday exactly at the local boundary time -- boundary counts as passed", () => {
  const result = computeDueReportWeek({
    now: new Date("2026-09-21T12:05:00Z"),
    timezone: "UTC",
    localTime: "12:05",
  });
  assert.deepEqual(result, { weekStartDate: "2026-09-14", weekEndDate: "2026-09-20" });
});

test("computeDueReportWeek: Sunday 23:59, well after that week's own Monday boundary -- same due week as the Monday-at-boundary case", () => {
  // 2026-09-27 is the Sunday of the week that started Monday 2026-09-21 (whose 12:05 boundary
  // already passed) -- the due week must still be 09-14..09-20, unchanged from the case above.
  const result = computeDueReportWeek({
    now: new Date("2026-09-27T23:59:00Z"),
    timezone: "UTC",
    localTime: "12:05",
  });
  assert.deepEqual(result, { weekStartDate: "2026-09-14", weekEndDate: "2026-09-20" });
});

test("computeDueReportWeek: correct across the America/Los_Angeles DST fall-back", () => {
  // 2026-11-02T21:00:00Z is 2026-11-02 13:00 in America/Los_Angeles (PST, UTC-8, confirmed via
  // real Intl output) -- a Monday, past the 12:05 boundary. The due week (Oct 26 - Nov 1) itself
  // spans the fall-back day (Nov 1), exercising the pure calendar-day arithmetic across it.
  const result = computeDueReportWeek({
    now: new Date("2026-11-02T21:00:00Z"),
    timezone: "America/Los_Angeles",
    localTime: "12:05",
  });
  assert.deepEqual(result, { weekStartDate: "2026-10-26", weekEndDate: "2026-11-01" });
});

test("computeDueReportWeek: correct across a year boundary", () => {
  // 2027-01-04 is a Monday, 13:00 UTC is past the 12:05 boundary -- the due week (Dec 28 - Jan 3)
  // spans the 2026/2027 year boundary.
  const result = computeDueReportWeek({
    now: new Date("2027-01-04T13:00:00Z"),
    timezone: "UTC",
    localTime: "12:05",
  });
  assert.deepEqual(result, { weekStartDate: "2026-12-28", weekEndDate: "2027-01-03" });
});

test("computeDueReportWeek: uses the TARGET timezone's own local Monday, not UTC's", () => {
  // 2026-09-20T21:00:00Z is still Sunday 2026-09-20 in UTC, but already 2026-09-21 06:00 (Monday)
  // in Asia/Tokyo (UTC+9, confirmed via real Intl output). Before the 12:05 Tokyo-local boundary,
  // so this must resolve as "Monday, before boundary" (stepping back a week), NOT as "Sunday"
  // (which a UTC-based implementation would incorrectly see).
  const result = computeDueReportWeek({
    now: new Date("2026-09-20T21:00:00Z"),
    timezone: "Asia/Tokyo",
    localTime: "12:05",
  });
  assert.deepEqual(result, { weekStartDate: "2026-09-07", weekEndDate: "2026-09-13" });
});

test("computeDueReportWeek: a long-dormant app only gets the single most recently due week, never a backlog", () => {
  // Two calls months apart both resolve to a "most recently due" week -- the function has no
  // memory of any previous call, so there is structurally no way for it to return more than one
  // week at a time; this documents that property rather than testing a stateful backfill (there
  // is none).
  const recent = computeDueReportWeek({ now: new Date("2026-09-21T13:00:00Z"), timezone: "UTC", localTime: "12:05" });
  const monthsLater = computeDueReportWeek({ now: new Date("2027-01-04T13:00:00Z"), timezone: "UTC", localTime: "12:05" });
  assert.notDeepEqual(recent, monthsLater);
  // monthsLater is still exactly ONE week wide, not a multi-week span.
  assert.equal(
    new Date(`${monthsLater.weekEndDate}T00:00:00Z`).getTime() - new Date(`${monthsLater.weekStartDate}T00:00:00Z`).getTime(),
    6 * 24 * 60 * 60 * 1000
  );
});

function metricRow(videoId: string, metricDate: string, metricName: string, metricValue: number) {
  return { videoId, metricDate, metricName, metricValue };
}

test("computeWeeklyReportContent: sums per-video rows into syncedVideoTotals for the week only", () => {
  const content = computeWeeklyReportContent({
    channelId: "UC_A",
    weekStartDate: "2026-09-14",
    weekEndDate: "2026-09-20",
    now: new Date("2026-09-25T00:00:00Z"),
    runs: [
      {
        requestedStartDate: "2026-09-07",
        requestedEndDate: "2026-09-20",
        videoCount: 1,
        skippedVideoIds: [],
        ranAt: new Date("2026-09-20T13:00:00Z"),
      },
    ],
    datesWithAnyMetricRow: new Set(),
    metricRecords: [
      metricRow("v1", "2026-09-14", "views", 10),
      metricRow("v1", "2026-09-20", "views", 5),
      metricRow("v1", "2026-09-21", "views", 999), // outside the week -- must be excluded
      metricRow("v1", "2026-09-14", "estimatedMinutesWatched", 20),
    ],
    videoTitlesById: new Map([["v1", "Video 1"]]),
  });

  assert.deepEqual(content.syncedVideoTotals, {
    views: 15,
    estimatedMinutesWatched: 20,
    subscribersGained: 0,
    subscribersLost: 0,
  });
});

test("computeWeeklyReportContent: status is 'final' only when the week's own data is fully covered", () => {
  const covered = computeWeeklyReportContent({
    channelId: "UC_A",
    weekStartDate: "2026-09-14",
    weekEndDate: "2026-09-20",
    now: new Date("2026-09-25T00:00:00Z"),
    runs: [
      {
        requestedStartDate: "2026-09-14",
        requestedEndDate: "2026-09-20",
        videoCount: 1,
        skippedVideoIds: [],
        ranAt: new Date("2026-09-20T13:00:00Z"),
      },
    ],
    datesWithAnyMetricRow: new Set(),
    metricRecords: [],
    videoTitlesById: new Map(),
  });
  assert.equal(covered.status, "final");

  const uncovered = computeWeeklyReportContent({
    channelId: "UC_A",
    weekStartDate: "2026-09-14",
    weekEndDate: "2026-09-20",
    now: new Date("2026-09-25T00:00:00Z"),
    runs: [], // nothing collected at all for this week
    datesWithAnyMetricRow: new Set(),
    metricRecords: [],
    videoTitlesById: new Map(),
  });
  assert.equal(uncovered.status, "provisional");
});

test("computeWeeklyReportContent: percentChange is null when the PREVIOUS week is not fully covered, even if the current week is", () => {
  const content = computeWeeklyReportContent({
    channelId: "UC_A",
    weekStartDate: "2026-09-14",
    weekEndDate: "2026-09-20",
    now: new Date("2026-09-25T00:00:00Z"),
    runs: [
      // Only the CURRENT week is covered -- the previous week (09-07..09-13) has no run at all,
      // matching the real Tropico Jazz situation this feature was designed against.
      {
        requestedStartDate: "2026-09-14",
        requestedEndDate: "2026-09-20",
        videoCount: 1,
        skippedVideoIds: [],
        ranAt: new Date("2026-09-20T13:00:00Z"),
      },
    ],
    datesWithAnyMetricRow: new Set(),
    metricRecords: [metricRow("v1", "2026-09-14", "views", 100)],
    videoTitlesById: new Map([["v1", "Video 1"]]),
  });

  assert.equal(content.status, "final"); // the current week's OWN coverage is complete
  assert.equal(content.percentChange, null); // but the comparison itself is not trustworthy
});

test("computeWeeklyReportContent: percentChange is populated when both weeks are fully covered", () => {
  const content = computeWeeklyReportContent({
    channelId: "UC_A",
    weekStartDate: "2026-09-14",
    weekEndDate: "2026-09-20",
    now: new Date("2026-09-25T00:00:00Z"),
    runs: [
      {
        requestedStartDate: "2026-09-07",
        requestedEndDate: "2026-09-20",
        videoCount: 1,
        skippedVideoIds: [],
        ranAt: new Date("2026-09-20T13:00:00Z"),
      },
    ],
    datesWithAnyMetricRow: new Set(),
    metricRecords: [
      metricRow("v1", "2026-09-14", "views", 200), // current week
      metricRow("v1", "2026-09-07", "views", 100), // previous week
    ],
    videoTitlesById: new Map([["v1", "Video 1"]]),
  });

  assert.deepEqual(content.percentChange, {
    views: 100, // (200-100)/100 * 100
    estimatedMinutesWatched: null, // 0 vs 0 -- computePercentChange(0,0) is null (previous === 0)
    subscribersGained: null,
    subscribersLost: null,
  });
});

test("computeWeeklyReportContent: topContent ranks videos by views within the week, limited to 5, and rows outside the week are excluded", () => {
  const content = computeWeeklyReportContent({
    channelId: "UC_A",
    weekStartDate: "2026-09-14",
    weekEndDate: "2026-09-20",
    now: new Date("2026-09-25T00:00:00Z"),
    runs: [],
    datesWithAnyMetricRow: new Set(),
    metricRecords: [
      metricRow("v1", "2026-09-14", "views", 10),
      metricRow("v2", "2026-09-15", "views", 50),
      metricRow("v2", "2026-09-16", "views", 5), // same video, second day -- summed
      metricRow("v3", "2026-08-01", "views", 9999), // outside the week -- excluded
    ],
    videoTitlesById: new Map([
      ["v1", "Video 1"],
      ["v2", "Video 2"],
    ]),
  });

  assert.deepEqual(content.topContent, [
    { videoId: "v2", title: "Video 2", views: 55 },
    { videoId: "v1", title: "Video 1", views: 10 },
  ]);
});

test("computeWeeklyReportContent: embeds provenance -- format version, generatedAt, source, metric definitions", () => {
  const now = new Date("2026-09-25T00:00:00Z");
  const content = computeWeeklyReportContent({
    channelId: "UC_A",
    weekStartDate: "2026-09-14",
    weekEndDate: "2026-09-20",
    now,
    runs: [],
    datesWithAnyMetricRow: new Set(),
    metricRecords: [],
    videoTitlesById: new Map(),
  });

  assert.equal(content.reportFormatVersion, 1);
  assert.equal(content.generatedAt, now.toISOString());
  assert.match(content.source, /no live YouTube API call/);
  assert.ok(content.metricDefinitions.views);
  assert.ok(content.metricDefinitions.subscribersGained);
});
