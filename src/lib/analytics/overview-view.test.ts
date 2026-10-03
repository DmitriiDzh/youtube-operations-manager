import assert from "node:assert/strict";
import test from "node:test";
import type { GetChannelOverviewResult } from "./contracts";
import { buildChannelOverviewView } from "./overview-view";

// Expected values are worked out by hand from the rules in granularity.ts (BL-118) and the 7-day provisional window (AGENTS.md §L).
// 2026-10-01 is a Thursday; the Monday-Sunday week containing it runs 2026-09-28 .. 2026-10-04.

const day = (date: string, views: number) => ({ date, views, estimatedMinutesWatched: views * 2, subscribersGained: 0, subscribersLost: 0 });
const zeros = { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 };

function overview(overrides: Partial<GetChannelOverviewResult> = {}): GetChannelOverviewResult {
  return {
    channelId: "UC1",
    startDate: "2026-09-29",
    endDate: "2026-10-02",
    previousStartDate: "2026-09-25",
    previousEndDate: "2026-09-28",
    daily: [day("2026-09-29", 1), day("2026-09-30", 2), day("2026-10-01", 3), day("2026-10-02", 4)],
    currentTotals: { ...zeros, views: 10 },
    previousTotals: zeros,
    viewCountingChangeInComparison: false,
    source: "local",
    collectedAt: "2026-10-03T08:00:00.000Z",
    ...overrides,
  };
}

test("day view keeps the overview untouched, adds the channel start, provisional date and no buckets", () => {
  const view = buildChannelOverviewView({ overview: overview(), channelStartDate: "2026-08-13", granularity: "day", now: new Date("2026-10-03T12:00:00Z") });
  assert.equal(view.source, "local");
  assert.equal(view.collectedAt, "2026-10-03T08:00:00.000Z");
  assert.equal(view.channelStartDate, "2026-08-13");
  assert.equal(view.provisionalFromDate, "2026-09-26"); // 2026-10-03 minus 7 days
  assert.equal(view.buckets, null);
  assert.equal(view.granularity, "day");
  assert.equal(view.previousPeriod.status, "full");
});

test("week view buckets the daily rows into Monday-Sunday weeks, clipped to the range and flagged partial", () => {
  const view = buildChannelOverviewView({ overview: overview(), channelStartDate: null, granularity: "week", now: new Date("2026-10-03T12:00:00Z") });
  // 2026-09-29 (Tue) .. 2026-09-30 sit in the week of Mon 2026-09-28; 2026-10-01 .. 2026-10-02 in the same week -> ONE bucket 09-29..10-02.
  assert.equal(view.buckets?.length, 1);
  assert.deepEqual(
    { start: view.buckets![0].periodStart, end: view.buckets![0].periodEnd, views: view.buckets![0].views, partial: view.buckets![0].partialBucket },
    { start: "2026-09-29", end: "2026-10-02", views: 10, partial: true }
  );
});

test("a comparison period before the channel existed is reported as predates_channel, a straddling one as partial", () => {
  const predates = buildChannelOverviewView({ overview: overview(), channelStartDate: "2026-09-29", granularity: "day", now: new Date("2026-10-03T12:00:00Z") });
  assert.equal(predates.previousPeriod.status, "predates_channel"); // previous period ends 09-28, channel created 09-29
  const partial = buildChannelOverviewView({ overview: overview(), channelStartDate: "2026-09-27", granularity: "day", now: new Date("2026-10-03T12:00:00Z") });
  assert.equal(partial.previousPeriod.status, "partial"); // starts 09-25 (before) ends 09-28 (after)
});
