// ---------------------------------------------------------------------------
// Acceptance criteria derived from docs/roadmap/plans/PHASE_9_SLICE_9D_PLAN.md §6, expected values
// computed by hand from the requirement before this file's own implementation was read line-by-line
// (AGENTS.md §L):
//
// AC-9D-01: computeAgeNormalizedViews reports not_yet_reached for an offset the video hasn't lived
//           long enough to reach yet, never a fabricated/null-without-explanation value.
// AC-9D-02: computeAgeNormalizedViews reports insufficient_history for an old-enough video with no
//           snapshot at or after publishedAt.
// AC-9D-03: computeAgeNormalizedViews picks the snapshot closest to the target offset, reporting
//           its own real elapsed days, when that snapshot is within tolerance of the offset.
// AC-9D-03b: computeAgeNormalizedViews reports insufficient_history (never a misleading "observed")
//            when the only available snapshot is too far from the target offset to trust.
// AC-9D-04: computeChannelVideoBaseline returns null/sample size 0 for an empty input, the correct
//           median for an odd/even count of non-null values, and never fabricates for a null value.
// AC-9D-05: assessBreakout never flags a breakout below the minimum baseline sample size, even when
//           the raw ratio would otherwise qualify.
// AC-9D-06: assessBreakout never fabricates a ratio when the video or baseline view count is null.
// AC-9D-06b: assessBreakout refuses to compare a video against a baseline computed at a DIFFERENT
//            dayOffset, never silently producing an age-mismatched ratio.
// AC-9D-07: assessEmergingChannel's reasons array names exactly which signal(s) fired.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import {
  assessBreakout,
  assessEmergingChannel,
  computeAgeNormalizedViews,
  computeChannelVideoBaseline,
  BREAKOUT_MIN_BASELINE_SAMPLE_SIZE,
  BREAKOUT_RATIO_THRESHOLD,
  EMERGING_MIN_BREAKOUT_VIDEOS,
  type VideoSnapshotWithTime,
} from "./historical-intelligence";

const DAY = 24 * 60 * 60 * 1000;

test("AC-9D-01: computeAgeNormalizedViews reports not_yet_reached for an offset the video hasn't lived long enough to reach yet", () => {
  const publishedAt = new Date("2026-09-25T00:00:00.000Z");
  const now = new Date("2026-09-27T00:00:00.000Z"); // exactly 2 days old
  const snapshots: VideoSnapshotWithTime[] = [{ viewCount: 500, observedAt: new Date(publishedAt.getTime() + 1 * DAY) }];

  const points = computeAgeNormalizedViews(snapshots, publishedAt, [1, 2, 7, 30], now);

  // day 1 has already elapsed and has a real snapshot exactly there.
  assert.deepEqual(points[0], { dayOffset: 1, viewCount: 500, basis: "observed", actualDaysSincePublish: 1 });
  // day 2 has also elapsed; no snapshot lands exactly there, but the day-1 snapshot is within
  // day-2's own tolerance (max(1, 2*0.25) = 1 day), so it's still usable.
  assert.equal(points[1].basis, "observed", "the day-1 snapshot is within day-2's own tolerance");
  // day 7 and day 30 have NOT elapsed yet for a 2-day-old video.
  assert.deepEqual(points[2], { dayOffset: 7, viewCount: null, basis: "not_yet_reached", actualDaysSincePublish: null });
  assert.deepEqual(points[3], { dayOffset: 30, viewCount: null, basis: "not_yet_reached", actualDaysSincePublish: null });
});

test("AC-9D-02: computeAgeNormalizedViews reports insufficient_history for an old-enough video with no snapshot at or after publishedAt", () => {
  const publishedAt = new Date("2026-08-01T00:00:00.000Z");
  const now = new Date("2026-09-27T00:00:00.000Z"); // well over 30 days old
  const snapshots: VideoSnapshotWithTime[] = [{ viewCount: 500, observedAt: new Date(publishedAt.getTime() - DAY) }]; // before publish -- excluded

  const points = computeAgeNormalizedViews(snapshots, publishedAt, [7], now);
  assert.deepEqual(points, [{ dayOffset: 7, viewCount: null, basis: "insufficient_history", actualDaysSincePublish: null }]);
});

test("AC-9D-03: computeAgeNormalizedViews picks the snapshot closest to the target offset, reporting its own real elapsed days, when within tolerance", () => {
  const publishedAt = new Date("2026-09-01T00:00:00.000Z");
  const now = new Date("2026-09-27T00:00:00.000Z");
  const snapshots: VideoSnapshotWithTime[] = [
    { viewCount: 100, observedAt: new Date(publishedAt.getTime() + 1 * DAY) }, // day 1
    { viewCount: 500, observedAt: new Date(publishedAt.getTime() + 6 * DAY) }, // day 6 -- closest to target 7, within its 1.75-day tolerance
    { viewCount: 900, observedAt: new Date(publishedAt.getTime() + 10 * DAY) }, // day 10
  ];

  const points = computeAgeNormalizedViews(snapshots, publishedAt, [7], now);
  assert.deepEqual(points, [{ dayOffset: 7, viewCount: 500, basis: "observed", actualDaysSincePublish: 6 }]);
});

test("AC-9D-03b: computeAgeNormalizedViews reports insufficient_history, never a misleading 'observed', when the only available snapshot is too far from the target offset", () => {
  const publishedAt = new Date("2026-09-01T00:00:00.000Z");
  const now = new Date("2026-09-27T00:00:00.000Z");
  // Only a day-30 snapshot exists; asked for day-7 (tolerance = max(1, 7*0.25) = 1.75 days) --
  // the day-30 snapshot is 23 days away, far outside tolerance.
  const snapshots: VideoSnapshotWithTime[] = [{ viewCount: 5000, observedAt: new Date(publishedAt.getTime() + 30 * DAY) }];

  const points = computeAgeNormalizedViews(snapshots, publishedAt, [7], now);
  assert.deepEqual(points, [{ dayOffset: 7, viewCount: null, basis: "insufficient_history", actualDaysSincePublish: null }]);
});

test("AC-9D-04: computeChannelVideoBaseline computes the correct median, handles empty/null input honestly", () => {
  assert.deepEqual(computeChannelVideoBaseline([], 7), { dayOffset: 7, medianViewCount: null, sampleSize: 0 });

  // Odd count: [10, 20, 30] -> median 20.
  assert.deepEqual(
    computeChannelVideoBaseline([{ viewCount: 30 }, { viewCount: 10 }, { viewCount: 20 }], 7),
    { dayOffset: 7, medianViewCount: 20, sampleSize: 3 }
  );

  // Even count: [10, 20, 30, 40] -> median (20+30)/2 = 25.
  assert.deepEqual(
    computeChannelVideoBaseline([{ viewCount: 10 }, { viewCount: 40 }, { viewCount: 20 }, { viewCount: 30 }], 7),
    { dayOffset: 7, medianViewCount: 25, sampleSize: 4 }
  );

  // A null viewCount is excluded from both the median and the sample size, never coerced to 0.
  assert.deepEqual(
    computeChannelVideoBaseline([{ viewCount: 10 }, { viewCount: null }, { viewCount: 20 }], 7),
    { dayOffset: 7, medianViewCount: 15, sampleSize: 2 }
  );
});

test("AC-9D-05: assessBreakout never flags a breakout below the minimum baseline sample size, even when the raw ratio would otherwise qualify", () => {
  // Ratio would be 10x (well above BREAKOUT_RATIO_THRESHOLD=3), but sample size is only 2 (< 3).
  const result = assessBreakout("v1", { viewCount: 10000, dayOffset: 7 }, { dayOffset: 7, medianViewCount: 1000, sampleSize: BREAKOUT_MIN_BASELINE_SAMPLE_SIZE - 1 });
  assert.equal(result.isBreakout, false);
  assert.equal(result.ratio, null, "a ratio is not even computed/reported when the sample size is too small");
  assert.match(result.reason, /sample size/);
});

test("AC-9D-05b: assessBreakout flags a breakout when the ratio meets the threshold with a sufficient sample size, at the same day offset", () => {
  const result = assessBreakout("v1", { viewCount: 9000, dayOffset: 7 }, { dayOffset: 7, medianViewCount: 1000, sampleSize: BREAKOUT_MIN_BASELINE_SAMPLE_SIZE });
  assert.equal(result.isBreakout, true);
  assert.equal(result.ratio, 9);
  assert.ok(result.ratio! >= BREAKOUT_RATIO_THRESHOLD);
  assert.match(result.reason, /day-7/);
});

test("AC-9D-06: assessBreakout never fabricates a ratio when the video or baseline view count is null", () => {
  const nullVideo = assessBreakout("v1", { viewCount: null, dayOffset: 7 }, { dayOffset: 7, medianViewCount: 1000, sampleSize: 5 });
  assert.equal(nullVideo.isBreakout, false);
  assert.equal(nullVideo.ratio, null);

  const nullBaseline = assessBreakout("v1", { viewCount: 5000, dayOffset: 7 }, { dayOffset: 7, medianViewCount: null, sampleSize: 0 });
  assert.equal(nullBaseline.isBreakout, false);
  assert.equal(nullBaseline.ratio, null);
});

test("AC-9D-06b: assessBreakout refuses to compare a video against a baseline computed at a different day offset", () => {
  // Ratio would be 9x if compared naively, but the video is measured at day-30 and the baseline at
  // day-7 -- an age-mismatched comparison, refused outright rather than silently computed.
  const result = assessBreakout("v1", { viewCount: 9000, dayOffset: 30 }, { dayOffset: 7, medianViewCount: 1000, sampleSize: 10 });
  assert.equal(result.isBreakout, false);
  assert.equal(result.ratio, null);
  assert.match(result.reason, /does not match/);
});

test("AC-9D-07: assessEmergingChannel's reasons array names exactly which signal(s) fired", () => {
  const neither = assessEmergingChannel("UC_A", 0, { value: -5, basis: "full_window" });
  assert.deepEqual(neither, { researchChannelId: "UC_A", recentBreakoutVideoCount: 0, subscriberVelocityPerDay: -5, isEmerging: false, reasons: [] });

  const onlyBreakouts = assessEmergingChannel("UC_B", EMERGING_MIN_BREAKOUT_VIDEOS, { value: null, basis: "insufficient_history" });
  assert.equal(onlyBreakouts.isEmerging, true);
  assert.equal(onlyBreakouts.reasons.length, 1);
  assert.match(onlyBreakouts.reasons[0], /breakout/);

  const onlyVelocity = assessEmergingChannel("UC_C", 0, { value: 12.5, basis: "full_window" });
  assert.equal(onlyVelocity.isEmerging, true);
  assert.equal(onlyVelocity.reasons.length, 1);
  assert.match(onlyVelocity.reasons[0], /velocity/);

  const both = assessEmergingChannel("UC_D", EMERGING_MIN_BREAKOUT_VIDEOS, { value: 12.5, basis: "full_window" });
  assert.equal(both.isEmerging, true);
  assert.equal(both.reasons.length, 2);

  // A stale_latest-basis positive velocity must not count as a real signal -- it does not reflect
  // the channel's CURRENT behavior, only a rate computed over an old, no-longer-current span.
  const staleVelocity = assessEmergingChannel("UC_E", 0, { value: 50, basis: "stale_latest" });
  assert.equal(staleVelocity.isEmerging, false);
  assert.deepEqual(staleVelocity.reasons, []);
});
