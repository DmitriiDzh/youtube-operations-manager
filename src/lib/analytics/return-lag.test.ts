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
