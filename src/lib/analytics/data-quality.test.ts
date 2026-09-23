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
      { requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-03", skippedVideoIds: [], ranAt: new Date("2026-09-04T00:00:00Z") },
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
      { requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-02", skippedVideoIds: [], ranAt: new Date("2026-09-03T00:00:00Z") },
    ],
    now: FAR_FUTURE_NOW,
  });

  assert.deepEqual(report.coveredDates, ["2026-09-01", "2026-09-02"]);
  assert.deepEqual(report.uncoveredDates, ["2026-09-03", "2026-09-04", "2026-09-05"]);
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
      { requestedStartDate: "2026-09-01", requestedEndDate: "2026-09-05", skippedVideoIds: ["v1"], ranAt: new Date("2026-09-06T00:00:00Z") },
      { requestedStartDate: "2026-09-06", requestedEndDate: "2026-09-10", skippedVideoIds: ["v1", "v2"], ranAt: new Date("2026-09-11T00:00:00Z") },
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
      { requestedStartDate: "2026-08-01", requestedEndDate: "2026-08-05", skippedVideoIds: ["v1"], ranAt: new Date("2026-08-06T00:00:00Z") },
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
      { requestedStartDate: "2026-09-05", requestedEndDate: "2026-09-10", skippedVideoIds: ["v1"], ranAt: new Date("2026-09-11T00:00:00Z") },
    ],
    now: FAR_FUTURE_NOW,
  });

  assert.deepEqual(report.videosWithSkips, [{ videoId: "v1", skipCount: 1, lastSkippedAt: "2026-09-11T00:00:00.000Z" }]);
});
