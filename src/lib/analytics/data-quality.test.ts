import assert from "node:assert/strict";
import test from "node:test";
import { computeDataQualityReport } from "./data-quality";

// A fixed "now" far enough after the report range that the reporting-lag window never overlaps
// it, unless a test explicitly wants to exercise that overlap.
const FAR_FUTURE_NOW = new Date("2026-12-01T00:00:00.000Z");

test("computeDataQualityReport: with no runs at all, every in-range date is uncovered", () => {
  const report = computeDataQualityReport({
    startDate: "2026-09-01",
    endDate: "2026-09-03",
    runs: [],
    now: FAR_FUTURE_NOW,
  });

  assert.deepEqual(report.coveredDates, []);
  assert.deepEqual(report.uncoveredDates, ["2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.deepEqual(report.tooRecentDates, []);
  assert.deepEqual(report.videosWithSkips, []);
});

test("computeDataQualityReport: a run covering the whole range marks every date covered", () => {
  const report = computeDataQualityReport({
    startDate: "2026-09-01",
    endDate: "2026-09-03",
    runs: [
      { requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-03", videoCount: 5, skippedVideoIds: [], ranAt: new Date("2026-09-04T00:00:00Z") },
    ],
    now: FAR_FUTURE_NOW,
  });

  assert.deepEqual(report.coveredDates, ["2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.deepEqual(report.uncoveredDates, []);
});

test("computeDataQualityReport: a run covering only part of the range leaves the rest uncovered", () => {
  const report = computeDataQualityReport({
    startDate: "2026-09-01",
    endDate: "2026-09-05",
    runs: [
      { requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-02", videoCount: 5, skippedVideoIds: [], ranAt: new Date("2026-09-03T00:00:00Z") },
    ],
    now: FAR_FUTURE_NOW,
  });

  assert.deepEqual(report.coveredDates, ["2026-09-01", "2026-09-02"]);
  assert.deepEqual(report.uncoveredDates, ["2026-09-03", "2026-09-04", "2026-09-05"]);
});

// Found by independent review, 2026-09-23: a run with zero videos attempted (e.g. collection
// fired before channel sync ever populated `videos`) proves nothing about coverage -- without this
// guard, every date in its range would show "covered" forever, hiding a real problem.
test("computeDataQualityReport: a run with zero videos attempted never counts as coverage", () => {
  const report = computeDataQualityReport({
    startDate: "2026-09-01",
    endDate: "2026-09-02",
    runs: [
      { requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-02", videoCount: 0, skippedVideoIds: [], ranAt: new Date("2026-09-03T00:00:00Z") },
    ],
    now: FAR_FUTURE_NOW,
  });

  assert.deepEqual(report.coveredDates, []);
  assert.deepEqual(report.uncoveredDates, ["2026-09-01", "2026-09-02"]);
});

// Hand-computed: now = 2026-09-10, lag = 2 days -> cutoff = 2026-09-08. Dates > cutoff
// (09-09, 09-10) are "too recent to expect data", not flagged as real gaps, even with zero
// coverage -- this is the exact scenario that would otherwise falsely flag the Analytics API's
// own normal reporting lag as a collection failure.
test("computeDataQualityReport: dates within the reporting-lag window are never flagged as uncovered gaps", () => {
  const report = computeDataQualityReport({
    startDate: "2026-09-06",
    endDate: "2026-09-10",
    runs: [],
    now: new Date("2026-09-10T12:00:00.000Z"),
  });

  assert.deepEqual(report.uncoveredDates, ["2026-09-06", "2026-09-07", "2026-09-08"]);
  assert.deepEqual(report.tooRecentDates, ["2026-09-09", "2026-09-10"]);
});

// A channel's data collected before analytics_collection_runs existed (this history table only
// started recording once this slice shipped) has real video_metrics_daily rows but no run record
// -- must not be flagged as "never collected" purely because the tracking mechanism postdates it.
test("computeDataQualityReport: a date with a real metric row but no run record is still covered, not flagged as a gap", () => {
  const report = computeDataQualityReport({
    startDate: "2026-09-01",
    endDate: "2026-09-03",
    runs: [],
    datesWithAnyMetricRow: new Set(["2026-09-02"]),
    now: FAR_FUTURE_NOW,
  });

  assert.deepEqual(report.coveredDates, ["2026-09-02"]);
  assert.deepEqual(report.uncoveredDates, ["2026-09-01", "2026-09-03"]);
});

test("computeDataQualityReport: aggregates repeated skips for the same video, keeping the latest skip time", () => {
  const report = computeDataQualityReport({
    startDate: "2026-09-01",
    endDate: "2026-09-10",
    runs: [
      { requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-05", videoCount: 5, skippedVideoIds: ["v1"], ranAt: new Date("2026-09-06T00:00:00Z") },
      { requestedStartDate: "2026-09-06", requestedEndDate: "2026-09-10", videoCount: 5, skippedVideoIds: ["v1", "v2"], ranAt: new Date("2026-09-11T00:00:00Z") },
    ],
    now: FAR_FUTURE_NOW,
  });

  assert.deepEqual(report.videosWithSkips, [
    { videoId: "v1", skipCount: 2, lastSkippedAt: "2026-09-11T00:00:00.000Z" },
    { videoId: "v2", skipCount: 1, lastSkippedAt: "2026-09-11T00:00:00.000Z" },
  ]);
});

test("computeDataQualityReport: a skip from a run entirely outside the requested range is excluded", () => {
  const report = computeDataQualityReport({
    startDate: "2026-09-01",
    endDate: "2026-09-05",
    runs: [
      { requestedStartDate: "2026-08-01", requestedEndDate: "2026-08-05", videoCount: 5, skippedVideoIds: ["v1"], ranAt: new Date("2026-08-06T00:00:00Z") },
    ],
    now: FAR_FUTURE_NOW,
  });

  assert.deepEqual(report.videosWithSkips, []);
});

test("computeDataQualityReport: a run overlapping only the edge of the requested range still counts its skip", () => {
  const report = computeDataQualityReport({
    startDate: "2026-09-01",
    endDate: "2026-09-05",
    runs: [
      { requestedStartDate: "2026-09-05", requestedEndDate: "2026-09-10", videoCount: 5, skippedVideoIds: ["v1"], ranAt: new Date("2026-09-11T00:00:00Z") },
    ],
    now: FAR_FUTURE_NOW,
  });

  assert.deepEqual(report.videosWithSkips, [{ videoId: "v1", skipCount: 1, lastSkippedAt: "2026-09-11T00:00:00.000Z" }]);
});

// Found by independent review, 2026-09-23: every real collection run attempts every
// currently-synced video, so a video absent from the LATEST overlapping run's own skippedVideoIds
// must have succeeded in that latest attempt -- self-healing, not a permanent scar. Without this,
// a video that failed once and later succeeded would still show as failing for as long as any
// query window overlapped the old failed run.
test("computeDataQualityReport: a video that succeeded in the latest overlapping run is no longer reported, even though an older run skipped it", () => {
  const report = computeDataQualityReport({
    startDate: "2026-09-01",
    endDate: "2026-09-10",
    runs: [
      { requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-05", videoCount: 5, skippedVideoIds: ["v1"], ranAt: new Date("2026-09-06T00:00:00Z") },
      // Later run, same video no longer skipped -- v1 must disappear from the report entirely.
      { requestedStartDate: "2026-09-06", requestedEndDate: "2026-09-10", videoCount: 5, skippedVideoIds: [], ranAt: new Date("2026-09-11T00:00:00Z") },
    ],
    now: FAR_FUTURE_NOW,
  });

  assert.deepEqual(report.videosWithSkips, []);
});

test("computeDataQualityReport: skipCount reflects total historical skips, even though only videos in the latest run are reported at all", () => {
  const report = computeDataQualityReport({
    startDate: "2026-09-01",
    endDate: "2026-09-15",
    runs: [
      { requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-05", videoCount: 5, skippedVideoIds: ["v1"], ranAt: new Date("2026-09-06T00:00:00Z") },
      { requestedStartDate: "2026-09-06", requestedEndDate: "2026-09-10", videoCount: 5, skippedVideoIds: ["v1"], ranAt: new Date("2026-09-11T00:00:00Z") },
      { requestedStartDate: "2026-09-11", requestedEndDate: "2026-09-15", videoCount: 5, skippedVideoIds: ["v1"], ranAt: new Date("2026-09-16T00:00:00Z") },
    ],
    now: FAR_FUTURE_NOW,
  });

  assert.deepEqual(report.videosWithSkips, [
    { videoId: "v1", skipCount: 3, lastSkippedAt: "2026-09-16T00:00:00.000Z" },
  ]);
});

// ---- BL-118: channel start date, ranges, and what "covered" means ------------------------------------------------------
import { compactDateRanges, extendDataQualityReport, PROVISIONAL_WINDOW_DAYS } from "./data-quality";

test("compactDateRanges joins consecutive days and splits on a gap, across a month boundary", () => {
  assert.deepEqual(compactDateRanges([]), []);
  assert.deepEqual(compactDateRanges(["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-03"]), [
    { startDate: "2026-08-30", endDate: "2026-09-01" },
    { startDate: "2026-09-03", endDate: "2026-09-03" },
  ]);
});

// The agent's own case: channel created 2026-08-13; collection exists from 2026-09-14; asked 2026-01-01..2026-10-03, now = 2026-10-03.
test("the agent's case: dates before the channel existed are 'not applicable', only 2026-08-13..2026-09-13 is a genuine gap", () => {
  const now = new Date("2026-10-03T18:26:00Z");
  const base = computeDataQualityReport({
    startDate: "2026-08-10",
    endDate: "2026-10-03",
    runs: [{ requestedStartDate: "2026-09-14", requestedEndDate: "2026-10-01", videoCount: 28, skippedVideoIds: [], ranAt: new Date("2026-10-02T10:00:00Z") }],
    now,
  });
  const { report, extras } = extendDataQualityReport({
    report: base,
    startDate: "2026-08-10",
    channelStartDate: "2026-08-13",
    datesWithAnyMetricRow: new Set(),
    now,
  });
  assert.deepEqual(extras.notApplicableRange, { startDate: "2026-08-10", endDate: "2026-08-12" });
  assert.deepEqual(extras.uncoveredRanges, [{ startDate: "2026-08-13", endDate: "2026-09-13" }]);
  assert.equal(report.uncoveredDates.length, 32, "2026-08-13 .. 2026-09-13 inclusive");
  assert.equal(report.uncoveredDates[0], "2026-08-13");
  assert.deepEqual(extras.coveredRanges, [{ startDate: "2026-09-14", endDate: "2026-10-01" }]);
  assert.equal(extras.channelStartDate, "2026-08-13");
});

test("an unknown channel start date changes nothing about the lists and says so (null), never guessing", () => {
  const now = FAR_FUTURE_NOW;
  const base = computeDataQualityReport({ startDate: "2026-09-01", endDate: "2026-09-03", runs: [], now });
  const { report, extras } = extendDataQualityReport({ report: base, startDate: "2026-09-01", channelStartDate: null, datesWithAnyMetricRow: new Set(), now });
  assert.deepEqual(report.uncoveredDates, ["2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.equal(extras.notApplicableRange, null);
  assert.equal(extras.channelStartDate, null);
});

test("a channel start date inside the range removes only the earlier dates; a start after the whole range makes everything not applicable", () => {
  const now = FAR_FUTURE_NOW;
  const base = computeDataQualityReport({ startDate: "2026-09-01", endDate: "2026-09-03", runs: [], now });
  const mid = extendDataQualityReport({ report: base, startDate: "2026-09-01", channelStartDate: "2026-09-02", datesWithAnyMetricRow: new Set(), now });
  assert.deepEqual(mid.report.uncoveredDates, ["2026-09-02", "2026-09-03"]);
  assert.deepEqual(mid.extras.notApplicableRange, { startDate: "2026-09-01", endDate: "2026-09-01" });
  const after = extendDataQualityReport({ report: base, startDate: "2026-09-01", channelStartDate: "2026-12-31", datesWithAnyMetricRow: new Set(), now });
  assert.deepEqual(after.report.uncoveredDates, []);
  assert.deepEqual(after.extras.notApplicableRange, { startDate: "2026-09-01", endDate: "2026-09-03" });
});

test("'covered' is not 'has data': a covered date with no metric row is listed in coveredWithoutData (2026-10-01 in the agent's report)", () => {
  const now = new Date("2026-10-03T18:26:00Z");
  const base = computeDataQualityReport({
    startDate: "2026-09-29",
    endDate: "2026-10-01",
    runs: [{ requestedStartDate: "2026-09-25", requestedEndDate: "2026-10-02", videoCount: 28, skippedVideoIds: [], ranAt: new Date("2026-10-02T10:00:00Z") }],
    now,
  });
  const { extras } = extendDataQualityReport({ report: base, startDate: "2026-09-29", channelStartDate: "2026-08-13", datesWithAnyMetricRow: new Set(["2026-09-29", "2026-09-30"]), now });
  assert.deepEqual(extras.coveredWithoutData, ["2026-10-01"]);
});

test("provisional dates are the covered ones inside the re-collection window (7 days): exactly the window edge is not provisional", () => {
  assert.equal(PROVISIONAL_WINDOW_DAYS, 7);
  const now = new Date("2026-10-10T12:00:00Z"); // cutoff = 2026-10-03: dates strictly after it are provisional
  const base = computeDataQualityReport({
    startDate: "2026-10-01",
    endDate: "2026-10-08",
    runs: [{ requestedStartDate: "2026-10-01", requestedEndDate: "2026-10-09", videoCount: 5, skippedVideoIds: [], ranAt: new Date("2026-10-10T08:00:00Z") }],
    now,
  });
  const { extras } = extendDataQualityReport({ report: base, startDate: "2026-10-01", channelStartDate: null, datesWithAnyMetricRow: new Set(), now });
  assert.deepEqual(extras.provisionalDates, ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
});

test("the covered-meaning text says it does not mean data is present", () => {
  const { extras } = extendDataQualityReport({
    report: computeDataQualityReport({ startDate: "2026-09-01", endDate: "2026-09-01", runs: [], now: FAR_FUTURE_NOW }),
    startDate: "2026-09-01",
    channelStartDate: null,
    datesWithAnyMetricRow: new Set(),
    now: FAR_FUTURE_NOW,
  });
  assert.match(extras.coveredMeans, /NOT mean data is present/);
});

import { isRangeFullyCovered } from "./data-quality";

test("BL-118 isRangeFullyCovered: every date covered by a run, or still inside the reporting lag, is fully covered; one uncovered date is not", () => {
  const now = new Date("2026-09-22T13:00:00Z"); // lag cutoff 2026-09-20: later dates count as covered
  const runs = [{ requestedStartDate: "2026-09-14", requestedEndDate: "2026-09-21", videoCount: 5 }];
  assert.equal(isRangeFullyCovered({ startDate: "2026-09-15", endDate: "2026-09-21", runs, now }), true);
  assert.equal(isRangeFullyCovered({ startDate: "2026-09-15", endDate: "2026-09-22", runs, now }), true, "2026-09-22 is inside the lag window");
  assert.equal(isRangeFullyCovered({ startDate: "2026-09-13", endDate: "2026-09-21", runs, now }), false, "2026-09-13 was never collected");
  assert.equal(isRangeFullyCovered({ startDate: "2026-08-01", endDate: "2026-08-02", runs, now }), false);
});

test("BL-118 isRangeFullyCovered: a run with no videos proves nothing, and several runs together can cover a range", () => {
  const now = new Date("2026-09-22T13:00:00Z");
  assert.equal(isRangeFullyCovered({ startDate: "2026-08-01", endDate: "2026-08-03", runs: [{ requestedStartDate: "2026-08-01", requestedEndDate: "2026-08-03", videoCount: 0 }], now }), false);
  const two = [
    { requestedStartDate: "2026-08-01", requestedEndDate: "2026-08-02", videoCount: 3 },
    { requestedStartDate: "2026-08-03", requestedEndDate: "2026-08-05", videoCount: 3 },
  ];
  assert.equal(isRangeFullyCovered({ startDate: "2026-08-01", endDate: "2026-08-05", runs: two, now }), true);
});

test("BL-118 isRangeFullyCovered: requireVideos=false lets a run that attempted no videos cover its range (channel totals, a channel with no videos)", () => {
  const now = new Date("2026-09-22T13:00:00Z");
  const runs = [{ requestedStartDate: "2026-08-01", requestedEndDate: "2026-08-03", videoCount: 0 }];
  assert.equal(isRangeFullyCovered({ startDate: "2026-08-01", endDate: "2026-08-03", runs, now }), false);
  assert.equal(isRangeFullyCovered({ startDate: "2026-08-01", endDate: "2026-08-03", runs, now, requireVideos: false }), true);
});

test("BL-120 isRangeFullyCovered: dates before the channel's start are not applicable -- a comparison period reaching back past the start is covered once everything since the start is", () => {
  const now = new Date("2026-10-03T13:00:00Z");
  // The channel was created 2026-08-13; a run covers 2026-08-13 .. 2026-10-01. The range below starts 2026-08-09 (4 days before the channel existed).
  const runs = [{ requestedStartDate: "2026-08-13", requestedEndDate: "2026-10-01", videoCount: 0 }];
  assert.equal(isRangeFullyCovered({ startDate: "2026-08-09", endDate: "2026-10-01", runs, now, requireVideos: false }), false, "without the start date those 4 days read as uncovered");
  assert.equal(isRangeFullyCovered({ startDate: "2026-08-09", endDate: "2026-10-01", runs, now, requireVideos: false, channelStartDate: "2026-08-13" }), true);
  // A day AFTER the start that no run covers still counts as uncovered.
  assert.equal(isRangeFullyCovered({ startDate: "2026-08-09", endDate: "2026-10-01", runs: [{ requestedStartDate: "2026-08-14", requestedEndDate: "2026-10-01", videoCount: 0 }], now, requireVideos: false, channelStartDate: "2026-08-13" }), false, "2026-08-13 is on/after the start and not covered");
  // Unknown start behaves as before (never guessed).
  assert.equal(isRangeFullyCovered({ startDate: "2026-08-09", endDate: "2026-10-01", runs, now, requireVideos: false, channelStartDate: null }), false);
});
