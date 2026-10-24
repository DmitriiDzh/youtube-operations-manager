import assert from "node:assert/strict";
import test from "node:test";
import { DAY_MS, MAX_GAP_MS, parseRangeDays } from "./contracts";
import { summariseLive, type LiveEventInput, type LiveSampleInput } from "./summarise";

// BL-213 (LIVE_ANALYTICS_PLAN.md §3): the summary's rules, values computed by hand from the plan, never from the code.
//   - an interval a→b counts only when b - a <= 10 min (MAX_GAP_MS); a longer one is a data gap;
//   - a counted interval belongs to sample a: its state (live → on air, otherwise not live), its UTC day, hour and broadcast;
//   - viewer-time = a.viewers × interval over live intervals with a count; average = viewer-time / time with a count;
//   - peak = the largest count among the samples; no count at all → null, never 0;
//   - BL-221 (owner, Telegram msg 3453 -- a requirement change, so the expected values below were recomputed by hand): a sample
//     taken while LIVE without a count is 0 viewers (YouTube omits concurrentViewers when nobody watches); a sample that is not
//     live without a count stays unknown.
//   - interruptions = encoder runs that ended early (encoder_run_exit with a cause other than pass_end).

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 21, 23, 50); // 2026-10-21 23:50 UTC
const s = (minute: number, broadcastId: string, lifeCycleStatus: string, viewers: number | null): LiveSampleInput => ({ sampledAt: T0 + minute * MIN, broadcastId, viewers, lifeCycleStatus });

const SAMPLES = [
  s(0, "B1", "live", 10), // 23:50
  s(5, "B1", "live", 20), // 23:55
  s(10, "B1", "live", null), // 00:00 -- live without a count: 0 viewers (BL-221)
  s(15, "B1", "live", 30), // 00:05 → next sample 12 min later: a data gap
  s(27, "B2", "ready", null), // 00:17
  s(32, "B2", "live", 40), // 00:22
  s(37, "B2", "live", 50), // 00:27 (last: no interval of its own)
];
const EVENTS: LiveEventInput[] = [
  { at: T0 + 12 * MIN, kind: "encoder_run_exit", cause: "encoder_exit" }, // 00:02, an interruption
  { at: T0 + 20 * MIN, kind: "encoder_run_exit", cause: "pass_end" }, // planned: not counted
  { at: T0 + 21 * MIN, kind: "encoder_run_exit", cause: "source_missing" }, // 00:11, an interruption
  { at: T0 + 22 * MIN, kind: "youtube_status", cause: null },
];

test("BL-213: totals over the fixture -- on air, not live, gaps, viewer-hours, average, peak, interruptions", () => {
  const summary = summariseLive({ samples: SAMPLES, events: EVENTS });
  assert.deepEqual(summary.totals, {
    samples: 7,
    onAirMs: 20 * MIN, // 0→5, 5→10, 10→15, 32→37
    notLiveMs: 5 * MIN, // 27→32 (ready)
    dataGaps: 1, // 15→27
    viewerHours: (10 * 5 + 20 * 5 + 0 * 5 + 40 * 5) / 60, // 350 viewer-minutes
    averageViewers: 350 / 20, // 20 minutes live (10→15 counts as 0 viewers since BL-221)
    peakViewers: 50,
    interruptions: 2,
  });
  assert.equal(summary.analytics, null, "stage 2's YouTube Analytics figures are not here yet");
});

test("BL-213: UTC days -- an interval belongs to the day of its first sample", () => {
  const { days } = summariseLive({ samples: SAMPLES, events: EVENTS });
  assert.deepEqual(days, [
    { date: "2026-10-21", samples: 2, onAirMs: 10 * MIN, notLiveMs: 0, dataGaps: 0, viewerHours: 150 / 60, averageViewers: 15, peakViewers: 20, interruptions: 0 },
    { date: "2026-10-22", samples: 5, onAirMs: 10 * MIN, notLiveMs: 5 * MIN, dataGaps: 1, viewerHours: 200 / 60, averageViewers: 20, peakViewers: 50, interruptions: 2 },
  ]);
});

test("BL-213: broadcasts -- grouped by broadcast id with their first and last sample", () => {
  const { broadcasts } = summariseLive({ samples: SAMPLES, events: EVENTS });
  assert.deepEqual(broadcasts, [
    { broadcastId: "B1", firstSampleAt: T0, lastSampleAt: T0 + 15 * MIN, samples: 4, onAirMs: 15 * MIN, notLiveMs: 0, dataGaps: 1, viewerHours: 150 / 60, averageViewers: 10, peakViewers: 30, interruptions: 1 },
    { broadcastId: "B2", firstSampleAt: T0 + 27 * MIN, lastSampleAt: T0 + 37 * MIN, samples: 3, onAirMs: 5 * MIN, notLiveMs: 5 * MIN, dataGaps: 0, viewerHours: 200 / 60, averageViewers: 40, peakViewers: 50, interruptions: 0 },
  ]);
});

test("BL-213: hours for the chart -- average and peak per UTC hour that has samples", () => {
  const { hours } = summariseLive({ samples: SAMPLES, events: EVENTS });
  assert.deepEqual(hours, [
    { hour: "2026-10-21T23:00:00.000Z", averageViewers: 15, peakViewers: 20 },
    { hour: "2026-10-22T00:00:00.000Z", averageViewers: 20, peakViewers: 50 },
  ]);
});

test("BL-213: nothing known stays null, never 0 (a live sample without a count is 0, BL-221); samples arrive in any order", () => {
  const empty = summariseLive({ samples: [], events: [] });
  assert.deepEqual(empty.totals, { samples: 0, onAirMs: 0, notLiveMs: 0, dataGaps: 0, viewerHours: 0, averageViewers: null, peakViewers: null, interruptions: 0 });
  assert.deepEqual([empty.days, empty.hours, empty.broadcasts], [[], [], []]);

  // Not live and no count: unknown.
  const notLive = summariseLive({ samples: [s(5, "B1", "ready", null), s(0, "B1", "ready", null)], events: [] });
  assert.equal(notLive.totals.notLiveMs, 5 * MIN);
  assert.equal(notLive.totals.averageViewers, null);
  assert.equal(notLive.totals.peakViewers, null);
  assert.deepEqual(notLive.hours, [{ hour: "2026-10-21T23:00:00.000Z", averageViewers: null, peakViewers: null }]);

  // BL-221 (owner msg 3453): live and no count -- nobody watched: 0, not unknown.
  const liveNoCounts = summariseLive({ samples: [s(5, "B1", "live", null), s(0, "B1", "live", null)], events: [] });
  assert.equal(liveNoCounts.totals.onAirMs, 5 * MIN);
  assert.equal(liveNoCounts.totals.averageViewers, 0);
  assert.equal(liveNoCounts.totals.peakViewers, 0);
  assert.deepEqual(liveNoCounts.hours, [{ hour: "2026-10-21T23:00:00.000Z", averageViewers: 0, peakViewers: 0 }]);
});

test("BL-213: the gap boundary -- exactly 10 minutes counts, 10 minutes and 1 ms is a gap", () => {
  assert.equal(MAX_GAP_MS, 10 * MIN);
  const exact = summariseLive({ samples: [{ ...s(0, "B1", "live", 4) }, { ...s(10, "B1", "live", 4) }], events: [] });
  assert.deepEqual([exact.totals.onAirMs, exact.totals.dataGaps], [10 * MIN, 0]);
  const over = summariseLive({ samples: [s(0, "B1", "live", 4), { ...s(10, "B1", "live", 4), sampledAt: T0 + 10 * MIN + 1 }], events: [] });
  assert.deepEqual([over.totals.onAirMs, over.totals.dataGaps], [0, 1]);
});

test("BL-213: the range in days is a whole number from 1 to 90; anything else is refused", () => {
  assert.equal(DAY_MS, 86_400_000);
  assert.equal(parseRangeDays("7"), 7);
  assert.equal(parseRangeDays(null), 7, "default: a week");
  assert.equal(parseRangeDays("1"), 1);
  assert.equal(parseRangeDays("90"), 90);
  for (const bad of ["0", "91", "-1", "2.5", "abc", ""]) assert.equal(parseRangeDays(bad), null, bad);
});
