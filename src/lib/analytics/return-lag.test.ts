import assert from "node:assert/strict";
import test from "node:test";
import { returnLagOf } from "./services";
import { pacificDayEnd } from "./staleness";

// BL-181 (FO-REQ-0020 §2.4, criterion 5): the Analytics API's lag per date -- the first collection run that got the date back, minus
// the end of the date's Pacific day (YouTube reporting days are Pacific Time; Google's Reporting dimensions page: "Depending on the time
// of year, Pacific time is either UTC-7 or UTC-8"). Every expected value below is worked out by hand.

test("pacificDayEnd: midnight Pacific after the date -- 07:00Z under daylight time, 08:00Z under standard time, across both switches", () => {
  assert.equal(pacificDayEnd("2026-10-10").toISOString(), "2026-10-11T07:00:00.000Z");
  assert.equal(pacificDayEnd("2026-11-10").toISOString(), "2026-11-11T08:00:00.000Z");
  // 2026-11-01 is the fall-back Sunday: the day 10-31 ends under daylight time, 11-01 (25 h long) under standard time.
  assert.equal(pacificDayEnd("2026-10-31").toISOString(), "2026-11-01T07:00:00.000Z");
  assert.equal(pacificDayEnd("2026-11-01").toISOString(), "2026-11-02T08:00:00.000Z");
  // 2026-03-08 is the spring-forward Sunday (23 h long).
  assert.equal(pacificDayEnd("2026-03-07").toISOString(), "2026-03-08T08:00:00.000Z");
  assert.equal(pacificDayEnd("2026-03-08").toISOString(), "2026-03-09T07:00:00.000Z");
});

// The rule (review finding 1 of the BL-181 independent review; this replaces the first version of these tests, whose rule took
// the first recorded run as a baseline for every later date -- wrong once a history catch-up or a backfill records a run with old
// dates, or on the upgrade day): date D is first returned at run R only when R asked for D and got it, and an EARLIER run that also
// asked for D did not get it. Without that proof the first return is unknown and the date is left out.
const run = (ranAt: string, requested: [string, string], newestVideoDate: string | null, newestChannelDate: string | null) => ({
  ranAt: new Date(ranAt),
  requestedStartDate: requested[0],
  requestedEndDate: requested[1],
  newestVideoDate,
  newestChannelDate,
});

test("returnLagOf: a date counts at the first run that got it after an earlier run asked for it without getting it", () => {
  const runs = [
    run("2026-10-12T09:05:00Z", ["2026-10-04", "2026-10-11"], "2026-10-10", "2026-10-09"), // given out of order on purpose
    run("2026-10-09T09:05:00Z", ["2026-10-01", "2026-10-08"], null, null), // before schema v87: nothing recorded, ignored
    run("2026-10-10T09:05:00Z", ["2026-10-02", "2026-10-09"], "2026-10-07", "2026-10-07"),
    run("2026-10-11T09:05:00Z", ["2026-10-03", "2026-10-10"], "2026-10-08", "2026-10-07"),
    run("2026-10-11T19:05:00Z", ["2026-10-08", "2026-10-10"], "2026-10-08", "2026-10-08"), // an evening run: only the channel totals moved
    // A history catch-up after the daily run: channel totals of an old range only. It asked for none of these dates: no effect.
    run("2026-10-12T09:30:00Z", ["2026-01-01", "2026-03-31"], null, "2026-03-31"),
  ];
  assert.deepEqual(returnLagOf(runs, "2026-10-01", "2026-10-31"), [
    // 10-10: asked and missing on 10-11 (morning and evening), back 2026-10-12T09:05Z; it ended 2026-10-11T07:00Z -> 26 h 5 min = 26.1.
    // Channel totals: still missing in the last run that asked -> unknown.
    { date: "2026-10-10", videoFirstReturnedAt: "2026-10-12T09:05:00.000Z", videoLagHours: 26.1, channelFirstReturnedAt: null, channelLagHours: null },
    // 10-09 ended 2026-10-10T07:00Z; both back at 2026-10-12T09:05Z -> 50 h 5 min = 50.1.
    { date: "2026-10-09", videoFirstReturnedAt: "2026-10-12T09:05:00.000Z", videoLagHours: 50.1, channelFirstReturnedAt: "2026-10-12T09:05:00.000Z", channelLagHours: 50.1 },
    // 10-08 ended 2026-10-09T07:00Z; videos back 2026-10-11T09:05Z -> 50.1; channel totals at the evening run 19:05Z -> 60.1.
    { date: "2026-10-08", videoFirstReturnedAt: "2026-10-11T09:05:00.000Z", videoLagHours: 50.1, channelFirstReturnedAt: "2026-10-11T19:05:00.000Z", channelLagHours: 60.1 },
    // 10-07 (got by the first recorded run, never seen missing) and 10-11 (never got) are unknown and left out.
  ]);
});

test("returnLagOf: the upgrade day -- an old-build run and a catch-up of an old range prove nothing; every date is unknown", () => {
  const runs = [
    run("2026-10-13T09:05:00Z", ["2026-10-05", "2026-10-12"], null, null), // the old build's morning run
    run("2026-10-13T09:20:00Z", ["2026-01-01", "2026-09-30"], null, "2026-09-30"), // the background history catch-up
    run("2026-10-14T09:05:00Z", ["2026-10-06", "2026-10-13"], "2026-10-12", "2026-10-12"), // the first daily run of the new build
  ];
  assert.deepEqual(returnLagOf(runs, "2026-10-01", "2026-10-31"), []);
});

test("returnLagOf: only the requested range; a backfill of another range changes nothing; winter days end at 08:00Z", () => {
  const runs = [
    run("2026-11-11T10:00:00Z", ["2026-11-03", "2026-11-10"], "2026-11-09", null),
    run("2026-11-12T10:00:00Z", ["2026-11-04", "2026-11-11"], "2026-11-10", null), // 11-10 ended 2026-11-11T08:00Z -> 26 h
    run("2026-11-12T20:00:00Z", ["2026-10-01", "2026-10-31"], "2026-10-31", null), // a backfill of October: asked no November date
    run("2026-11-13T10:00:00Z", ["2026-11-05", "2026-11-12"], "2026-11-11", null), // 11-11 ended 2026-11-12T08:00Z -> 26 h
  ];
  assert.deepEqual(returnLagOf(runs, "2026-11-10", "2026-11-10"), [
    { date: "2026-11-10", videoFirstReturnedAt: "2026-11-12T10:00:00.000Z", videoLagHours: 26, channelFirstReturnedAt: null, channelLagHours: null },
  ]);
  assert.deepEqual(returnLagOf(runs, "2026-11-01", "2026-11-30").map((row) => [row.date, row.videoLagHours]), [
    ["2026-11-11", 26],
    ["2026-11-10", 26],
  ]);
  assert.deepEqual(returnLagOf([runs[0]], "2026-11-01", "2026-11-30"), [], "one run proves nothing");
});

test("returnLagOf: a range that ends before every run (a period the history back-fill has not reached) is empty, never an error", () => {
  const runs = [
    run("2026-10-10T09:05:00Z", ["2026-10-02", "2026-10-09"], "2026-10-07", "2026-10-07"),
    run("2026-10-11T09:05:00Z", ["2026-10-03", "2026-10-10"], "2026-10-08", "2026-10-08"),
  ];
  assert.deepEqual(returnLagOf(runs, "2025-01-01", "2025-01-31"), []);
  assert.deepEqual(returnLagOf([], "2026-10-01", "2026-10-31"), []);
});

// BL-245 (owner 2026-11-06): the hourly freshness probes are passed to returnLagOf as runs too -- channel level only
// (`newestVideoDate: null`), asking [today UTC - 5, today UTC]. Expected values worked out by hand: 2026-11-06 is under Pacific
// standard time (after the 11-01 switch), so its day ends 2026-11-07T08:00Z.
const probeRun = (ranAt: string, requested: [string, string], newestChannelDate: string | null) => run(ranAt, requested, null, newestChannelDate);

test("BL-245: hourly probes time a channel date to the hour; a probe that already has the date with no earlier miss proves nothing", () => {
  const probes = [
    probeRun("2026-11-08T03:07:00Z", ["2026-11-03", "2026-11-08"], "2026-11-05"),
    probeRun("2026-11-08T04:07:00Z", ["2026-11-03", "2026-11-08"], "2026-11-06"),
  ];
  // 11-06: missing at 03:07Z, back at 04:07Z; 04:07Z - 2026-11-07T08:00Z = 20 h 7 min -> 20.1.
  // 11-05: the first probe already had it, nothing earlier asked -> unknown, left out. No video column: probes say nothing about it.
  assert.deepEqual(returnLagOf(probes, "2026-11-01", "2026-11-08"), [
    { date: "2026-11-06", videoFirstReturnedAt: null, videoLagHours: null, channelFirstReturnedAt: "2026-11-08T04:07:00.000Z", channelLagHours: 20.1 },
  ]);
});

test("BL-245: collection runs and probes together -- a run's miss is the proof for a probe's hit; the video lag stays the runs'", () => {
  const mixed = [
    // The daily run of 11-07 (yesterday = 11-06 asked): neither the videos nor the channel had 11-06 yet.
    run("2026-11-07T12:05:00Z", ["2026-10-30", "2026-11-06"], "2026-11-05", "2026-11-05"),
    probeRun("2026-11-08T04:07:00Z", ["2026-11-03", "2026-11-08"], "2026-11-06"),
    // The daily run of 11-08: the videos' 11-06 is back.
    run("2026-11-08T12:05:00Z", ["2026-10-31", "2026-11-07"], "2026-11-06", "2026-11-06"),
  ];
  // 11-06 channel: missed by the 11-07 run, first back at the 04:07Z probe -> 20.1. Video: missed 11-07, back at the 11-08 12:05Z
  // run: 12:05Z - 2026-11-07T08:00Z = 28 h 5 min -> 28.1. 11-07: asked by the probe and the 11-08 run, never got -> left out.
  assert.deepEqual(returnLagOf(mixed, "2026-11-01", "2026-11-08"), [
    { date: "2026-11-06", videoFirstReturnedAt: "2026-11-08T12:05:00.000Z", videoLagHours: 28.1, channelFirstReturnedAt: "2026-11-08T04:07:00.000Z", channelLagHours: 20.1 },
  ]);
  // Without the run, the single probe proves nothing for 11-06.
  assert.deepEqual(returnLagOf([mixed[1]], "2026-11-01", "2026-11-08"), []);
});

test("BL-245: a failed probe (no newest date) is not a miss; a probe whose range does not cover the date says nothing about it", () => {
  const failedThenHit = [
    probeRun("2026-11-08T03:07:00Z", ["2026-11-03", "2026-11-08"], null), // the query failed (or returned no rows)
    probeRun("2026-11-08T04:07:00Z", ["2026-11-03", "2026-11-08"], "2026-11-06"),
  ];
  assert.deepEqual(returnLagOf(failedThenHit, "2026-11-06", "2026-11-06"), []);

  const otherRangeThenHit = [
    probeRun("2026-11-08T03:07:00Z", ["2026-11-01", "2026-11-05"], "2026-11-05"), // asked up to 11-05 only: no word on 11-06
    probeRun("2026-11-08T04:07:00Z", ["2026-11-03", "2026-11-08"], "2026-11-06"),
  ];
  assert.deepEqual(returnLagOf(otherRangeThenHit, "2026-11-06", "2026-11-06"), []);
});
