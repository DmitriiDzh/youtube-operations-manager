import { enumerateDates } from "./period";

/**
 * Phase 8 follow-up, slice 2 (docs/roadmap/FUTURE_PHASES.md §4's "data-quality/missing-data
 * diagnostics"). Pure computation over a channel's collection-run history, kept separate from
 * `services.ts` (no I/O) per `docs/DEVELOPMENT_PLAYBOOK.md` §6.2's "pure functions in their own
 * file" rule, mirroring `period.ts`/`staleness.ts` elsewhere in this module.
 *
 * **Why this can't be derived from `video_metrics_daily` alone:** live-verified 2026-09-23 against
 * a real low-traffic video that the Analytics API silently OMITS a day from its response when
 * that video had zero activity that day -- it is not returned as a zero-value row. An absent
 * `video_metrics_daily` row is therefore ambiguous between "never collected" and "collected, zero
 * activity" without a separate record of which date ranges collection actually attempted. That
 * record is `analytics_collection_runs` (`src/lib/db.ts`), populated by every `collectMetrics`
 * call.
 *
 * A date is "covered" if at least one recorded run's own requested range includes it -- this is
 * channel-level coverage (did the channel get a collection attempt that day), not per-video
 * coverage. A per-video-per-day coverage model would need to track which videos existed and were
 * actually queried on which specific day, a materially larger data model than this diagnostic's
 * actual purpose (telling an operator/agent "do I trust the numbers for this range" and "which
 * videos need re-collecting") justifies as a first slice.
 */

export const ANALYTICS_REPORTING_LAG_DAYS = 2;

export type CollectionRunSummary = {
  requestedStartDate: string;
  requestedEndDate: string;
  videoCount: number;
  skippedVideoIds: string[];
  ranAt: Date;
};

export type VideoSkipSummary = {
  videoId: string;
  /** How many overlapping runs skipped this video -- historical context; presence in this list at
   * all already means the LATEST overlapping run also skipped it (see `computeDataQualityReport`'s
   * "latest run wins" doc comment). */
  skipCount: number;
  lastSkippedAt: string;
};

export type DataQualityReport = {
  coveredDates: string[];
  uncoveredDates: string[];
  /**
   * Dates within the reporting-lag window (the most recent `ANALYTICS_REPORTING_LAG_DAYS` days
   * relative to `now`) -- excluded from `uncoveredDates` even if no run covers them yet, since the
   * Analytics API itself would not have data for them regardless of whether collection ran (the
   * same lag `docs/ARCHITECTURE.md` §14.8 documents for `getChannelOverview`'s own totals).
   */
  tooRecentDates: string[];
  videosWithSkips: VideoSkipSummary[];
};

function formatDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function computeDataQualityReport(args: {
  startDate: string;
  endDate: string;
  runs: readonly CollectionRunSummary[];
  /**
   * Dates that have at least one `video_metrics_daily` row for the channel (any video, any
   * metric) -- a fallback coverage signal for data collected BEFORE `analytics_collection_runs`
   * existed (this history table itself only started recording once this slice shipped, so a
   * channel's own pre-existing collected data would otherwise show as "never collected" purely
   * because no run record happens to predate it). A single real metric row on a date is strong
   * evidence *something* was collected that day -- unlike a single video's own missing row (which
   * is genuinely ambiguous, per this module's main doc comment), a channel going to zero rows
   * across every video on a day it otherwise has surrounding data is not the normal case this
   * fallback needs to handle.
   */
  datesWithAnyMetricRow?: ReadonlySet<string>;
  now: Date;
}): DataQualityReport {
  const datesWithAnyMetricRow = args.datesWithAnyMetricRow ?? new Set<string>();
  const allDates = enumerateDates(args.startDate, args.endDate);

  const cutoff = new Date(args.now);
  cutoff.setUTCDate(cutoff.getUTCDate() - ANALYTICS_REPORTING_LAG_DAYS);
  const cutoffDate = formatDateUtc(cutoff);

  const coveredDates: string[] = [];
  const uncoveredDates: string[] = [];
  const tooRecentDates: string[] = [];

  for (const date of allDates) {
    if (date > cutoffDate) {
      tooRecentDates.push(date);
      continue;
    }
    // A run with zero videos attempted (e.g. collection fired before channel sync ever populated
    // `videos`, or a channel genuinely has none) proves nothing about coverage -- found by
    // independent review, 2026-09-23: without this guard, such a run would mark every date in its
    // range "covered" forever (the same-day freshness gate blocks a retry), with zero skip
    // evidence to reveal anything went wrong. Exactly the false "all clear" this diagnostic exists
    // to prevent.
    const isCovered =
      args.runs.some(
        (run) => run.videoCount > 0 && date >= run.requestedStartDate && date <= run.requestedEndDate
      ) || datesWithAnyMetricRow.has(date);
    if (isCovered) {
      coveredDates.push(date);
    } else {
      uncoveredDates.push(date);
    }
  }

  // Only runs whose own requested range overlaps [startDate, endDate] contribute a skip to this
  // report -- a video skipped in a run about an unrelated period shouldn't count against this
  // range's own data quality.
  const overlappingRuns = args.runs.filter(
    (run) => run.requestedStartDate <= args.endDate && run.requestedEndDate >= args.startDate
  );

  // Every real collection run attempts every currently-synced video (collectMetrics iterates
  // videoStore.listVideosByChannel), so a video absent from the MOST RECENT overlapping run's own
  // skippedVideoIds must have succeeded in that latest attempt -- self-healing, not a permanent
  // scar. Without this "latest run wins" rule (found by independent review, 2026-09-23), a video
  // that failed once and succeeded on every later rolling-window run would still show as "having a
  // collection failure" for as long as any query window overlapped that one old run -- up to ~4
  // weeks with the default 7-day auto-collect window.
  const latestOverlappingRun = overlappingRuns.reduce<CollectionRunSummary | null>(
    (latest, run) => (!latest || run.ranAt > latest.ranAt ? run : latest),
    null
  );

  const totalSkipCounts = new Map<string, number>();
  for (const run of overlappingRuns) {
    for (const videoId of run.skippedVideoIds) {
      totalSkipCounts.set(videoId, (totalSkipCounts.get(videoId) ?? 0) + 1);
    }
  }

  const videosWithSkips: VideoSkipSummary[] = (latestOverlappingRun?.skippedVideoIds ?? [])
    .map((videoId) => ({
      videoId,
      // Historical count across every overlapping run, for context -- but presence in this list
      // at all already means the LATEST attempt failed (see rule above).
      skipCount: totalSkipCounts.get(videoId) ?? 1,
      lastSkippedAt: latestOverlappingRun!.ranAt.toISOString(),
    }))
    .sort((a, b) => b.skipCount - a.skipCount);

  return { coveredDates, uncoveredDates, tooRecentDates, videosWithSkips };
}
