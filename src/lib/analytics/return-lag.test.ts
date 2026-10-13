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

const run = (ranAt: string, newestVideoDate: string | null, newestChannelDate: string | null) => ({ ranAt: new Date(ranAt), newestVideoDate, newestChannelDate });

test("returnLagOf: a date counts at the first run whose newest date reaches it; the first recorded run is only the baseline", () => {
  const runs = [
    run("2026-10-12T09:05:00Z", "2026-10-10", "2026-10-09"), // given out of order on purpose
    run("2026-10-09T09:05:00Z", null, null), // before schema v87: nothing recorded, ignored
    run("2026-10-10T09:05:00Z", "2026-10-07", "2026-10-07"), // baseline
    run("2026-10-11T09:05:00Z", "2026-10-08", "2026-10-07"),
    run("2026-10-11T19:05:00Z", "2026-10-08", "2026-10-08"), // an evening run: only the channel totals moved
  ];
  assert.deepEqual(returnLagOf(runs, "2026-10-01", "2026-10-31"), [
    // 10-10 ended 2026-10-11T07:00Z; first back 2026-10-12T09:05Z -> 26 h 5 min = 26.1.
    { date: "2026-10-10", videoFirstReturnedAt: "2026-10-12T09:05:00.000Z", videoLagHours: 26.1, channelFirstReturnedAt: null, channelLagHours: null },
    // 10-09 ended 2026-10-10T07:00Z; both back at 2026-10-12T09:05Z -> 50 h 5 min = 50.1 (two days arrived in one run).
    { date: "2026-10-09", videoFirstReturnedAt: "2026-10-12T09:05:00.000Z", videoLagHours: 50.1, channelFirstReturnedAt: "2026-10-12T09:05:00.000Z", channelLagHours: 50.1 },
    // 10-08 ended 2026-10-09T07:00Z; videos back 2026-10-11T09:05Z -> 50.1; channel totals at the evening run 19:05Z -> 60.1.
    { date: "2026-10-08", videoFirstReturnedAt: "2026-10-11T09:05:00.000Z", videoLagHours: 50.1, channelFirstReturnedAt: "2026-10-11T19:05:00.000Z", channelLagHours: 60.1 },
  ]);
});

test("returnLagOf: only the requested range; a run whose newest date goes back does not re-date anything; winter days end at 08:00Z", () => {
  const runs = [
    run("2026-11-11T10:00:00Z", "2026-11-09", null),
    run("2026-11-12T10:00:00Z", "2026-11-10", null), // 11-10 ended 2026-11-11T08:00Z -> 26 h
    run("2026-11-12T20:00:00Z", "2026-11-08", null), // a narrower backfill run: the newest it returned is older, nothing changes
    run("2026-11-13T10:00:00Z", "2026-11-11", null), // 11-11 ended 2026-11-12T08:00Z -> 26 h
  ];
  assert.deepEqual(returnLagOf(runs, "2026-11-10", "2026-11-10"), [
    { date: "2026-11-10", videoFirstReturnedAt: "2026-11-12T10:00:00.000Z", videoLagHours: 26, channelFirstReturnedAt: null, channelLagHours: null },
  ]);
  assert.deepEqual(returnLagOf(runs, "2026-11-01", "2026-11-30").map((row) => [row.date, row.videoLagHours]), [
    ["2026-11-11", 26],
    ["2026-11-10", 26],
  ]);
  assert.deepEqual(returnLagOf([run("2026-11-11T10:00:00Z", "2026-11-09", null)], "2026-11-01", "2026-11-30"), [], "one run is only a baseline");
});
