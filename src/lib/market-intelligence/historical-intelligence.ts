// ---------------------------------------------------------------------------
// Phase 9 slice 9D (docs/roadmap/plans/PHASE_9_SLICE_9D_PLAN.md) -- pure, no-I/O historical
// intelligence computed over raw market_video_snapshots/market_channel_snapshots rows, styled
// identically to derived-metrics.ts: zero I/O, `now` always an explicit argument, every "no
// answer" case reports an explicit reason rather than a fabricated number (owner spec §9: "expose
// limitations when history is incomplete"). Ships with zero callers, same as derived-metrics.ts
// did at first (9B added its first real caller two slices later) -- a real service action/API
// route/UI consumer is a separate, later slice's own scope.
// ---------------------------------------------------------------------------

import type { FieldVelocity } from "./derived-metrics";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type VideoSnapshotWithTime = {
  viewCount: number | null;
  observedAt: Date;
};

export type AgeNormalizedBasis = "observed" | "insufficient_history" | "not_yet_reached";

export type AgeNormalizedPoint = {
  dayOffset: number;
  viewCount: number | null;
  basis: AgeNormalizedBasis;
  /** The real elapsed days between publishedAt and the snapshot actually used -- transparency for
   * when the closest available snapshot doesn't land exactly on `dayOffset` (spec §9). `null` when
   * `basis` isn't `"observed"`. */
  actualDaysSincePublish: number | null;
};

/**
 * How far (in days) the closest available snapshot may sit from the requested `dayOffset` and
 * still count as "observed" for that offset -- `max(1 day, 25% of the offset)` (found necessary by
 * advisor review: without a tolerance, a video's ONLY snapshot at day 30 would be reported as its
 * "day 7" performance if it happened to be the closest candidate, silently no longer age-normalized
 * at all -- exactly what spec §9 exists to prevent). Outside this tolerance, the offset reports
 * `insufficient_history` instead.
 */
export function ageNormalizedTolerance(dayOffset: number): number {
  return Math.max(1, dayOffset * 0.25);
}

/**
 * Owner spec §9 (age-normalized comparison): for each requested day offset (e.g. 1/3/7/30), picks
 * the video snapshot whose elapsed time since `publishedAt` is closest to that offset, among
 * snapshots observed AT OR AFTER `publishedAt` (a snapshot somehow timestamped before the video's
 * own publish date is not a valid candidate for "views at day N" and is excluded, not treated as a
 * negative-day observation) AND within `ageNormalizedTolerance` of the target offset.
 *
 * Two distinct "no answer" cases, deliberately not conflated (owner spec §10's own "no data is
 * inherently ambiguous" finding, applied here): `not_yet_reached` (the video is physically too
 * young for this offset to apply yet -- `now - publishedAt < dayOffset`) is a fundamentally
 * different fact from `insufficient_history` (the video is old enough, but no snapshot exists close
 * enough to that point -- a real gap in observation, not a property of the video itself).
 */
export function computeAgeNormalizedViews(
  snapshots: VideoSnapshotWithTime[],
  publishedAt: Date,
  dayOffsets: number[],
  now: Date
): AgeNormalizedPoint[] {
  const ageAtNowDays = (now.getTime() - publishedAt.getTime()) / MS_PER_DAY;

  const candidates = snapshots
    .map((s) => ({ snapshot: s, daysSincePublish: (s.observedAt.getTime() - publishedAt.getTime()) / MS_PER_DAY }))
    .filter((c) => c.daysSincePublish >= 0);

  return dayOffsets.map((dayOffset) => {
    if (ageAtNowDays < dayOffset) {
      return { dayOffset, viewCount: null, basis: "not_yet_reached", actualDaysSincePublish: null };
    }
    if (candidates.length === 0) {
      return { dayOffset, viewCount: null, basis: "insufficient_history", actualDaysSincePublish: null };
    }
    const closest = candidates.reduce((best, candidate) =>
      Math.abs(candidate.daysSincePublish - dayOffset) < Math.abs(best.daysSincePublish - dayOffset) ? candidate : best
    );
    if (Math.abs(closest.daysSincePublish - dayOffset) > ageNormalizedTolerance(dayOffset)) {
      return { dayOffset, viewCount: null, basis: "insufficient_history", actualDaysSincePublish: null };
    }
    return {
      dayOffset,
      viewCount: closest.snapshot.viewCount,
      basis: "observed",
      actualDaysSincePublish: closest.daysSincePublish,
    };
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export type ChannelVideoBaseline = {
  /** The age (in days since each video's own publish date) this baseline's view counts were
   * measured at -- e.g. 7 for a "day-7 performance" baseline. `assessBreakout` below refuses to
   * compare a video against a baseline computed at a DIFFERENT `dayOffset` (found necessary by
   * advisor review: comparing a video's LIFETIME view count against a baseline of other videos'
   * own lifetime counts is not age-normalized at all -- spec §9's own "avoid comparing old and new
   * videos only by total views" applies to baselines exactly as much as to raw comparisons; an old
   * video's lifetime count would always dwarf a new video's, making every old video look like a
   * "breakout" and no new video ever qualify, regardless of its real relative performance). */
  dayOffset: number;
  medianViewCount: number | null;
  /** How many videos actually contributed a non-null viewCount -- transparency for judging whether
   * the median is representative (owner spec §10: "do not assume one universal baseline formula",
   * never silently treat a tiny sample as reliable). */
  sampleSize: number;
};

/**
 * Owner spec §10 (channel baselines) -- deliberately ONE simple, named methodology (median
 * age-normalized video view count at a single, caller-chosen `dayOffset`), not a claimed-universal
 * formula: the caller decides what counts as "recent" (e.g. published in the last 90 days) and
 * computes each video's own `computeAgeNormalizedViews` point at `dayOffset` before calling this --
 * this function only computes the median over whatever set of same-age-offset points it's given.
 */
export function computeChannelVideoBaseline(
  ageNormalizedViewCountsAtOffset: { viewCount: number | null }[],
  dayOffset: number
): ChannelVideoBaseline {
  const nonNullViewCounts = ageNormalizedViewCountsAtOffset.map((v) => v.viewCount).filter((v): v is number => v !== null);
  return { dayOffset, medianViewCount: median(nonNullViewCounts), sampleSize: nonNullViewCounts.length };
}

// A "materially outperform" ratio -- a named, adjustable starting point, deliberately NOT the owner
// spec's own 9x illustrative example (10k -> 90k), which was never stated as a mandated cutoff.
export const BREAKOUT_RATIO_THRESHOLD = 3;
// A median computed from fewer than this many videos is not treated as a reliable baseline to
// compare against -- "do not assume one universal baseline formula" extends to not trusting a
// baseline built on too little data.
export const BREAKOUT_MIN_BASELINE_SAMPLE_SIZE = 3;

export type BreakoutAssessment = {
  videoId: string;
  dayOffset: number;
  videoViewCount: number | null;
  channelBaselineMedianViewCount: number | null;
  ratio: number | null;
  isBreakout: boolean;
  reason: string;
};

/**
 * Owner spec §11 (breakout detection) -- exposes the full comparison (the video's own count, the
 * channel's baseline, the ratio) rather than an opaque score, per the spec's own explicit
 * requirement ("do not provide opaque 'viral scores' without components"). The video's own view
 * count MUST be measured at the same `dayOffset` as the channel baseline (both from
 * `computeAgeNormalizedViews`) -- comparing at mismatched ages is exactly the "old vs. new by total
 * views" comparison spec §9 forbids, and is refused outright rather than silently computing a
 * misleading ratio.
 */
export function assessBreakout(
  videoId: string,
  video: { viewCount: number | null; dayOffset: number },
  channelBaseline: ChannelVideoBaseline
): BreakoutAssessment {
  const base = {
    videoId,
    dayOffset: video.dayOffset,
    videoViewCount: video.viewCount,
    channelBaselineMedianViewCount: channelBaseline.medianViewCount,
  };

  if (video.dayOffset !== channelBaseline.dayOffset) {
    return {
      ...base,
      ratio: null,
      isBreakout: false,
      reason: `video's own day offset (${video.dayOffset}) does not match the channel baseline's day offset (${channelBaseline.dayOffset}) -- refusing an age-mismatched comparison`,
    };
  }
  if (video.viewCount === null || channelBaseline.medianViewCount === null) {
    return { ...base, ratio: null, isBreakout: false, reason: "no view count available for this video or the channel baseline" };
  }
  if (channelBaseline.sampleSize < BREAKOUT_MIN_BASELINE_SAMPLE_SIZE) {
    return {
      ...base,
      ratio: null,
      isBreakout: false,
      reason: `channel baseline sample size (${channelBaseline.sampleSize}) is below the minimum (${BREAKOUT_MIN_BASELINE_SAMPLE_SIZE})`,
    };
  }
  if (channelBaseline.medianViewCount === 0) {
    return { ...base, ratio: null, isBreakout: false, reason: "channel baseline median view count is 0 -- ratio is undefined" };
  }

  const ratio = video.viewCount / channelBaseline.medianViewCount;
  const isBreakout = ratio >= BREAKOUT_RATIO_THRESHOLD;
  const dayLabel = `day-${channelBaseline.dayOffset}`;
  return {
    ...base,
    ratio,
    isBreakout,
    reason: isBreakout
      ? `${ratio.toFixed(1)}x the channel's median ${dayLabel} views (${channelBaseline.medianViewCount})`
      : `${ratio.toFixed(1)}x the channel's median ${dayLabel} views (${channelBaseline.medianViewCount}), below the ${BREAKOUT_RATIO_THRESHOLD}x threshold`,
  };
}

// A channel needs at least this many recent breakout videos for that signal alone to count.
export const EMERGING_MIN_BREAKOUT_VIDEOS = 2;

export type EmergingChannelAssessment = {
  researchChannelId: string;
  recentBreakoutVideoCount: number;
  subscriberVelocityPerDay: number | null;
  isEmerging: boolean;
  reasons: string[];
};

/**
 * Owner spec §12 (emerging channel detection) -- deliberately narrower than the spec's full signal
 * list (multiple recent breakouts, sustained acceleration, increased upload success, unusual
 * relative performance, new format adoption): uses only the two signals this slice has grounded
 * data for -- recent breakout video count (§11 above) and subscriber velocity (9A's own
 * `computeSnapshotVelocity`). The richer, topic/format-based signals need 9E's topic model first
 * and are not invented here without it (a deliberate, named simplification, not a silently dropped
 * requirement). `reasons` always states which signal(s) actually fired (spec's own "do not label a
 * channel 'promising' without observable supporting data ... expose why it was surfaced").
 */
export function assessEmergingChannel(
  researchChannelId: string,
  recentBreakoutVideoCount: number,
  subscriberVelocity: FieldVelocity
): EmergingChannelAssessment {
  const reasons: string[] = [];

  if (recentBreakoutVideoCount >= EMERGING_MIN_BREAKOUT_VIDEOS) {
    reasons.push(`${recentBreakoutVideoCount} recent breakout videos (at least ${EMERGING_MIN_BREAKOUT_VIDEOS} required)`);
  }
  // Only a velocity computed over a genuinely current span counts as a "momentum" signal --
  // `stale_latest` (the newest real data is itself older than the requested window) and
  // `insufficient_history` describe a rate that does NOT reflect the channel's current behavior,
  // so a positive value under either basis is never treated as a real signal here.
  const isCurrentVelocity = subscriberVelocity.basis === "full_window" || subscriberVelocity.basis === "partial_window";
  if (subscriberVelocity.value !== null && subscriberVelocity.value > 0 && isCurrentVelocity) {
    reasons.push(`positive subscriber velocity (${subscriberVelocity.value.toFixed(1)}/day, ${subscriberVelocity.basis})`);
  }

  return {
    researchChannelId,
    recentBreakoutVideoCount,
    subscriberVelocityPerDay: subscriberVelocity.value,
    isEmerging: reasons.length > 0,
    reasons,
  };
}
