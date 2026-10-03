import assert from "node:assert/strict";
import test from "node:test";
import { bucketDailyRows, type DailyChannelRow } from "./granularity";

const row = (date: string, views: number, over: Partial<DailyChannelRow> = {}): DailyChannelRow => ({
  date,
  views,
  estimatedMinutesWatched: views * 10,
  subscribersGained: 0,
  subscribersLost: 0,
  ...over,
});

// 2026-09-14 is a Monday, 2026-09-20 a Sunday, 2026-09-21 a Monday (hand-checked against the calendar).
test("weeks run Monday-Sunday; a full week is not partial and sums its days", () => {
  const buckets = bucketDailyRows({
    daily: [row("2026-09-14", 5), row("2026-09-16", 7, { subscribersGained: 2 }), row("2026-09-20", 1, { subscribersLost: 1 })],
    granularity: "week",
    startDate: "2026-09-14",
    endDate: "2026-09-20",
  });
  assert.equal(buckets.length, 1);
  assert.deepEqual(buckets[0], {
    periodStart: "2026-09-14",
    periodEnd: "2026-09-20",
    calendarDays: 7,
    partialBucket: false,
    views: 13,
    estimatedMinutesWatched: 130,
    subscribersGained: 2,
    subscribersLost: 1,
  });
});

test("edge weeks are clipped to the requested range and flagged partial; a quiet week in the middle is still a bucket of zeros", () => {
  // 2026-09-16 (Wed) .. 2026-10-06 (Tue): partial first week, full 09-21..09-27 and 09-28..10-04, partial last week
  const buckets = bucketDailyRows({
    daily: [row("2026-09-16", 4), row("2026-09-29", 9), row("2026-10-06", 2)],
    granularity: "week",
    startDate: "2026-09-16",
    endDate: "2026-10-06",
  });
  assert.deepEqual(
    buckets.map((b) => [b.periodStart, b.periodEnd, b.calendarDays, b.partialBucket, b.views]),
    [
      ["2026-09-16", "2026-09-20", 5, true, 4],
      ["2026-09-21", "2026-09-27", 7, false, 0],
      ["2026-09-28", "2026-10-04", 7, false, 9],
      ["2026-10-05", "2026-10-06", 2, true, 2],
    ]
  );
});

test("months are calendar months, clipped and flagged at the edges, including leap-year February", () => {
  const buckets = bucketDailyRows({
    daily: [row("2028-01-31", 1), row("2028-02-29", 2), row("2028-03-01", 3)],
    granularity: "month",
    startDate: "2028-01-31",
    endDate: "2028-03-01",
  });
  assert.deepEqual(
    buckets.map((b) => [b.periodStart, b.periodEnd, b.calendarDays, b.partialBucket, b.views]),
    [
      ["2028-01-31", "2028-01-31", 1, true, 1],
      ["2028-02-01", "2028-02-29", 29, false, 2],
      ["2028-03-01", "2028-03-01", 1, true, 3],
    ]
  );
});

test("rows outside the requested range are ignored; an empty range of rows still returns the buckets", () => {
  const buckets = bucketDailyRows({ daily: [row("2026-08-01", 99)], granularity: "week", startDate: "2026-09-14", endDate: "2026-09-20" });
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].views, 0);
});

test("a single-day range gives one partial bucket of one day", () => {
  const [bucket] = bucketDailyRows({ daily: [row("2026-09-16", 6)], granularity: "week", startDate: "2026-09-16", endDate: "2026-09-16" });
  assert.deepEqual([bucket.periodStart, bucket.periodEnd, bucket.calendarDays, bucket.partialBucket, bucket.views], ["2026-09-16", "2026-09-16", 1, true, 6]);
});

import { classifyPreviousPeriod } from "./granularity";

test("classifyPreviousPeriod: the agent's case — channel created 2026-08-13, previous period 2026-06-22..2026-08-12 predates it", () => {
  assert.equal(classifyPreviousPeriod({ previousStartDate: "2026-06-22", previousEndDate: "2026-08-12", channelStartDate: "2026-08-13" }), "predates_channel");
});

test("classifyPreviousPeriod: boundaries — ending on the creation day is partial, starting on it is full, an unknown start is never judged", () => {
  const base = { channelStartDate: "2026-08-13" };
  assert.equal(classifyPreviousPeriod({ ...base, previousStartDate: "2026-07-20", previousEndDate: "2026-08-13" }), "partial");
  assert.equal(classifyPreviousPeriod({ ...base, previousStartDate: "2026-08-13", previousEndDate: "2026-08-26" }), "full");
  assert.equal(classifyPreviousPeriod({ ...base, previousStartDate: "2026-08-14", previousEndDate: "2026-08-27" }), "full");
  assert.equal(classifyPreviousPeriod({ previousStartDate: "2026-06-22", previousEndDate: "2026-08-12", channelStartDate: null }), "full");
});
