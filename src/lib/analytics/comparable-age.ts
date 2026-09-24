/**
 * Phase 8 follow-up, slice 3 (docs/roadmap/FUTURE_PHASES.md §4, "comparing videos at comparable
 * ages"). Pure calendar/aggregation logic -- no I/O -- mirroring `period.ts`/`data-quality.ts`'s
 * own "pure functions in their own file" pattern (`docs/DEVELOPMENT_PLAYBOOK.md` §6.2).
 *
 * **Why Pacific Time, not UTC or the operator's local timezone:** `video_metrics_daily.metricDate`
 * is the YouTube Analytics API's own `day` dimension, which is a **Pacific-Time** calendar day
 * (`src/lib/youtube-read-gateway/analytics-api.ts`'s own `VideoAnalyticsMetricRow.date` doc
 * comment, `docs/roadmap/plans/PHASE_8_PLAN.md` §10 item 4). A video's `publishedAt` (from
 * `videos.publishedAt`, the YouTube Data API v3's own field) is a real UTC instant. To align "day
 * 0" of a video's life with the same day-numbering the Analytics API already uses for every later
 * row, `publishedAt` must be converted to ITS Pacific-Time calendar date, not UTC's -- otherwise a
 * video published at, say, 02:00 UTC (still the previous Pacific-Time evening) would be off by one
 * day against every other video compared against it. Day 0 is therefore a **partial day**: the
 * hours before publication on that Pacific calendar date are not part of the video's life, but the
 * Analytics API itself reports whole-day totals with no finer granularity, so this is the same
 * partial-first-day approximation YouTube Studio's own "Compare videos" feature makes.
 *
 * **Why a missing day is "unknown," never a fabricated zero:** the Analytics API silently omits a
 * day with genuinely zero activity from its response (live-verified 2026-09-23, see
 * `data-quality.ts`'s own doc comment) -- an absent `video_metrics_daily` row is ambiguous between
 * "never collected" and "collected, zero activity." `data-quality.ts` resolves that ambiguity at
 * the channel level using `analytics_collection_runs`, but that table records which channel-wide
 * date ranges were attempted, not which specific videos were actually queried in a given past run
 * (a video published after an older run's own snapshot of `videos` would never have been attempted
 * by it, and there is no historical record of channel membership to check against). Given that
 * unresolved ambiguity, this module deliberately does NOT reuse `analytics_collection_runs` to
 * infer "known zero" -- exactly the same "a materially larger data model than this diagnostic's
 * actual purpose justifies as a first slice" tradeoff `data-quality.ts` itself already accepted for
 * its own, narrower scope. A real `video_metrics_daily` row is the only fact this module treats as
 * "known"; every other day-offset is "unknown," which means: (a) it is never included in `points`,
 * and (b) it stops the cumulative running total dead at the last contiguous known day (never
 * zero-filled, never skipped-over-and-continued). This may under-report a genuinely low-traffic
 * video's true cumulative total, which is an accepted, documented limitation for this slice, not a
 * bug -- a more precise per-video-per-run "was this video actually queried" model would need an
 * additive schema change (e.g. a `queriedVideoIdsJson` column on `analytics_collection_runs`) and
 * is left as a future follow-up, not attempted here.
 */

const PACIFIC_TIME_ZONE = "America/Los_Angeles";

// en-CA formats as YYYY-MM-DD directly -- the same trick used elsewhere in this codebase's
// timezone-aware code (e.g. `staleness.ts`) to avoid hand-rolling date-part formatting.
const pacificDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: PACIFIC_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Converts a UTC ISO timestamp (e.g. `videos.publishedAt`) to its Pacific-Time calendar date. */
export function toPacificCalendarDate(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`comparable-age: invalid ISO timestamp "${isoTimestamp}"`);
  }
  return pacificDateFormatter.format(parsed);
}

/**
 * Difference in whole calendar days between two `YYYY-MM-DD` dates, both already in the same
 * day-numbering frame (Pacific Time) -- computed via `Date.UTC` on the parsed y/m/d components
 * (never `new Date(dateString)` directly) so the arithmetic never drifts across a DST transition,
 * mirroring `period.ts`'s own UTC-midnight convention.
 */
export function diffCalendarDays(fromDate: string, toDate: string): number {
  const toUtcMidnight = (date: string): number => {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((toUtcMidnight(toDate) - toUtcMidnight(fromDate)) / MS_PER_DAY);
}

/**
 * Additive metrics only -- summing a ratio/average metric (e.g. `averageViewDuration`,
 * `annotationClickThroughRate`) across days produces a meaningless number. An explicit allowlist,
 * not "every `ANALYTICS_METRIC_NAMES` entry except a denylist," so a future metric added to that
 * list defaults to NOT being offered for cumulative comparison until someone deliberately confirms
 * it is additive.
 */
export const CUMULATIVE_COMPARISON_METRIC_NAMES = [
  "views",
  "redViews",
  "engagedViews",
  "comments",
  "likes",
  "dislikes",
  "videosAddedToPlaylists",
  "videosRemovedFromPlaylists",
  "shares",
  "estimatedMinutesWatched",
  "estimatedRedMinutesWatched",
  "subscribersGained",
  "subscribersLost",
  "annotationImpressions",
  "annotationClickableImpressions",
  "annotationClosableImpressions",
  "annotationClicks",
  "annotationCloses",
  "cardImpressions",
  "cardTeaserImpressions",
  "cardClicks",
  "cardTeaserClicks",
] as const;

export type CumulativeComparisonMetricName = (typeof CUMULATIVE_COMPARISON_METRIC_NAMES)[number];

export type ComparableAgeDailyPoint = { dayOffset: number; value: number };
export type ComparableAgeCumulativePoint = { dayOffset: number; cumulativeValue: number };

export type ComparableAgeSeriesComputation = {
  publishDatePacific: string;
  /** Every day-offset with an actual collected row, sorted ascending. Never zero-filled. */
  points: ComparableAgeDailyPoint[];
  /**
   * A running total from day 0, stopping at (and not including) the first day-offset with no
   * data. Empty when day 0 itself has no data -- a legitimate, reportable fact, not an error.
   */
  cumulativePoints: ComparableAgeCumulativePoint[];
};

export function computeComparableAgeSeries(args: {
  publishedAt: string;
  metricRows: ReadonlyArray<{ metricDate: string; metricValue: number }>;
  maxDays: number;
}): ComparableAgeSeriesComputation {
  const publishDatePacific = toPacificCalendarDate(args.publishedAt);

  const valueByOffset = new Map<number, number>();
  for (const row of args.metricRows) {
    const offset = diffCalendarDays(publishDatePacific, row.metricDate);
    // A metric date before the video's own Pacific-Time publish date, or beyond the requested
    // window, is out of scope for this comparison -- never included, never counted as a gap.
    if (offset < 0 || offset > args.maxDays) continue;
    valueByOffset.set(offset, (valueByOffset.get(offset) ?? 0) + row.metricValue);
  }

  const points: ComparableAgeDailyPoint[] = [...valueByOffset.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dayOffset, value]) => ({ dayOffset, value }));

  const cumulativePoints: ComparableAgeCumulativePoint[] = [];
  let running = 0;
  for (let offset = 0; offset <= args.maxDays; offset += 1) {
    const value = valueByOffset.get(offset);
    if (value === undefined) break;
    running += value;
    cumulativePoints.push({ dayOffset: offset, cumulativeValue: running });
  }

  return { publishDatePacific, points, cumulativePoints };
}

/**
 * The cumulative value at exactly `dayOffset` days-since-publish, or `null` if coverage doesn't
 * reach that day (contiguously, from day 0 -- see `computeComparableAgeSeries`'s own doc comment).
 * A thin, shared wrapper -- extracted because more than one Phase 7 agent-operations capability
 * needs "this video's cumulative metric value at a specific comparison day" (first
 * `find_comparable_videos`, owner spec §10; then the asset-performance join, owner spec §16) and
 * this project's own convention (AGENTS.md §D) is one shared implementation, never two independent
 * copies of the same age-alignment arithmetic.
 */
export function getCumulativeValueAtDayOffset(args: {
  publishedAt: string;
  metricRows: ReadonlyArray<{ metricDate: string; metricValue: number }>;
  dayOffset: number;
}): number | null {
  const series = computeComparableAgeSeries({
    publishedAt: args.publishedAt,
    metricRows: args.metricRows,
    maxDays: args.dayOffset,
  });
  const point = series.cumulativePoints.find((p) => p.dayOffset === args.dayOffset);
  return point ? point.cumulativeValue : null;
}
