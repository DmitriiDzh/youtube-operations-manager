import { computeDataQualityReport, type CollectionRunSummary, type DataQualityReport } from "./data-quality";
import { computePercentChange } from "./period";

/**
 * Phase 8 follow-up, slice 4 of 4 (docs/roadmap/FUTURE_PHASES.md §4, "analytical reports and
 * weekly channel reviews"). Pure computation -- no I/O -- mirroring `data-quality.ts`/
 * `comparable-age.ts`'s own "pure functions in their own file" pattern.
 *
 * **Trigger design (owner instruction, 2026-09-23): "Давай завяжемся на то же время что мы
 * выбираем в настройках -- 12-05 сейчас по понедельникам."** Reuses the SAME `localTime`/
 * `timezone` Settings-tab pair the daily auto-collection boundary already uses
 * (`staleness.ts`/`analytics_sync_settings`) -- no separate weekly-report setting. A report
 * becomes due once the most recently passed Monday-at-`localTime` boundary (in the operator's own
 * local timezone) has occurred, and covers the full Monday-Sunday week immediately BEFORE that
 * boundary Monday. Missed weeks are never backfilled -- if the app was closed for a month, the
 * next dashboard load generates a report for only the single most recently completed week, never
 * one per skipped week (matching this module's own accepted-limitation philosophy, same as
 * `comparable-age.ts`'s "no backfill" decision).
 *
 * **Local trigger time vs. Pacific-Time report data (advisor review, 2026-09-23):** the trigger
 * boundary (Monday 12:05) is evaluated in the OPERATOR's own local timezone (from Settings), but
 * the resulting `weekStartDate`/`weekEndDate` are Monday-Sunday calendar dates compared against
 * `video_metrics_daily.metricDate`, which are Pacific-Time calendar days (the Analytics API's own
 * convention, `comparable-age.ts`'s own doc comment). These two "Monday"s are NOT necessarily the
 * same calendar day for an operator outside Pacific Time. This is deliberately not corrected here
 * (the owner's own instruction ties the trigger to their own local clock) -- the `status`
 * mechanism below (provisional -> final) is what actually protects against the resulting skew: a
 * week whose last Pacific-Time day hasn't cleared the reporting lag yet from the trigger's own
 * local perspective simply stays "provisional" until a later dashboard load re-checks it.
 */

export const WEEKLY_REPORT_FORMAT_VERSION = 1;

export const WEEKLY_REPORT_SOURCE_DESCRIPTION =
  "local video_metrics_daily rows for currently-synced videos -- no live YouTube API call";

/**
 * One line per field actually summed into `syncedVideoTotals` -- the literal "documented metric
 * definitions" `FUTURE_PHASES.md` §4 requires, embedded in every stored report so a reader (human
 * or agent) never has to go read this module's source to know what a number means.
 */
export const SYNCED_VIDEO_TOTALS_METRIC_DEFINITIONS: Record<string, string> = {
  views: "Sum of the `views` metric across every currently-synced video's own video_metrics_daily rows for this week. Undercounts the true channel total: excludes any video no longer synced (e.g. deleted) and any activity not attributable to a specific video (docs/ARCHITECTURE.md §14.8).",
  estimatedMinutesWatched: "Same scope and caveat as `views` above, for estimated watch-time minutes.",
  subscribersGained: "Sum of the Analytics API's own per-video `subscribersGained` attribution. Video-attributed only -- excludes subscribers gained directly from the channel page, which a per-video report cannot see (docs/ARCHITECTURE.md §14.8). Not the same number YouTube Studio's own channel-wide subscriber count would show.",
  subscribersLost: "Same scope and caveat as `subscribersGained` above.",
};

function addDaysToDateString(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The Monday of the calendar week containing `date` (Monday-Sunday weeks), as a `YYYY-MM-DD`. */
function mondayOnOrBefore(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun,1=Mon,...,6=Sat
  const daysSinceMonday = (weekday + 6) % 7; // Mon->0, Tue->1, ..., Sun->6
  return addDaysToDateString(date, -daysSinceMonday);
}

function formatZonedDateAndTime(date: Date, timezone: string): { localDate: string; localTime: string } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}`,
  };
}

/**
 * The most recently completed Monday-Sunday week whose report is due, given the operator's own
 * local Monday-`localTime` boundary. Pure string comparison of zoned local date/time (like
 * `staleness.ts`'s `isAnalyticsCollectionStale`), never absolute-instant arithmetic -- correct
 * across a DST transition with no manual offset code, and total (never throws, never null): there
 * is always a "most recently due week," even if `now` is well before this week's own boundary
 * (in which case it's still last week's due report, already generated in the ordinary case).
 */
export function computeDueReportWeek(args: {
  now: Date;
  timezone: string;
  localTime: string;
}): { weekStartDate: string; weekEndDate: string } {
  const { localDate, localTime } = formatZonedDateAndTime(args.now, args.timezone);
  const mondayOfCurrentWeek = mondayOnOrBefore(localDate);
  const boundaryPassedThisWeek =
    localDate > mondayOfCurrentWeek || (localDate === mondayOfCurrentWeek && localTime >= args.localTime);
  const referenceMonday = boundaryPassedThisWeek
    ? mondayOfCurrentWeek
    : addDaysToDateString(mondayOfCurrentWeek, -7);

  return {
    weekStartDate: addDaysToDateString(referenceMonday, -7),
    weekEndDate: addDaysToDateString(referenceMonday, -1),
  };
}

/** True when every date in the report's own week is actually covered (no gaps, none too recent). */
function isWeekFullyCovered(report: DataQualityReport): boolean {
  return report.uncoveredDates.length === 0 && report.tooRecentDates.length === 0;
}

export type WeeklyReportMetricTotals = {
  views: number;
  estimatedMinutesWatched: number;
  subscribersGained: number;
  subscribersLost: number;
};

export type WeeklyReportTopContentEntry = {
  videoId: string;
  title: string;
  views: number;
};

export type WeeklyReportPercentChange = {
  views: number | null;
  estimatedMinutesWatched: number | null;
  subscribersGained: number | null;
  subscribersLost: number | null;
};

export type WeeklyReportContent = {
  reportFormatVersion: number;
  channelId: string;
  weekStartDate: string;
  weekEndDate: string;
  generatedAt: string;
  /**
   * "final" once every date in THIS week is actually covered by local data (no gap, nothing too
   * recent) -- "provisional" otherwise. A provisional report is replaced (never a new row) the
   * next time `runWeeklyReportIfDue` re-checks the same due week and finds it now fully covered.
   * A "final" report is never touched again, even if later re-collection would change its numbers
   * (this is a frozen historical snapshot, per the owner's own "reproducible reports" requirement).
   */
  status: "final" | "provisional";
  /** Always the literal `WEEKLY_REPORT_SOURCE_DESCRIPTION` below -- `string`, not a literal type,
   * so this shape matches `weeklyReportContentSchema`'s own `z.string()` field (a stored report is
   * parsed back from JSON through that schema, which cannot narrow to a literal type). */
  source: string;
  metricDefinitions: Record<string, string>;
  syncedVideoTotals: WeeklyReportMetricTotals;
  previousWeekTotals: WeeklyReportMetricTotals;
  /**
   * `null` (the whole object, not per-field) unless BOTH this week and the previous week are
   * fully covered -- comparing against a mostly-uncollected previous week would measure collection
   * coverage, not real change (`FUTURE_PHASES.md` §4's "avoid unsupported conclusions from small
   * samples"). When present, each field individually follows `computePercentChange`'s own
   * "`null` when the previous value is exactly 0" rule.
   */
  percentChange: WeeklyReportPercentChange | null;
  currentWeekDataQuality: DataQualityReport;
  previousWeekDataQuality: DataQualityReport;
  topContent: WeeklyReportTopContentEntry[];
};

const TOP_CONTENT_LIMIT = 5;

export function computeWeeklyReportContent(args: {
  channelId: string;
  weekStartDate: string;
  weekEndDate: string;
  now: Date;
  runs: readonly CollectionRunSummary[];
  datesWithAnyMetricRow: ReadonlySet<string>;
  /** Every collected metric row for the channel (all metrics, all dates) -- filtered internally. */
  metricRecords: ReadonlyArray<{ videoId: string; metricDate: string; metricName: string; metricValue: number }>;
  videoTitlesById: ReadonlyMap<string, string>;
}): WeeklyReportContent {
  const previousWeekEndDate = addDaysToDateString(args.weekStartDate, -1);
  const previousWeekStartDate = addDaysToDateString(args.weekStartDate, -7);

  const currentWeekDataQuality = computeDataQualityReport({
    startDate: args.weekStartDate,
    endDate: args.weekEndDate,
    runs: args.runs,
    datesWithAnyMetricRow: args.datesWithAnyMetricRow,
    now: args.now,
  });
  const previousWeekDataQuality = computeDataQualityReport({
    startDate: previousWeekStartDate,
    endDate: previousWeekEndDate,
    runs: args.runs,
    datesWithAnyMetricRow: args.datesWithAnyMetricRow,
    now: args.now,
  });

  const sumTotals = (startDate: string, endDate: string): WeeklyReportMetricTotals => {
    const totals: WeeklyReportMetricTotals = {
      views: 0,
      estimatedMinutesWatched: 0,
      subscribersGained: 0,
      subscribersLost: 0,
    };
    for (const record of args.metricRecords) {
      if (record.metricDate < startDate || record.metricDate > endDate) continue;
      if (record.metricName === "views") totals.views += record.metricValue;
      else if (record.metricName === "estimatedMinutesWatched") totals.estimatedMinutesWatched += record.metricValue;
      else if (record.metricName === "subscribersGained") totals.subscribersGained += record.metricValue;
      else if (record.metricName === "subscribersLost") totals.subscribersLost += record.metricValue;
    }
    return totals;
  };

  const syncedVideoTotals = sumTotals(args.weekStartDate, args.weekEndDate);
  const previousWeekTotals = sumTotals(previousWeekStartDate, previousWeekEndDate);

  const bothWeeksFullyCovered = isWeekFullyCovered(currentWeekDataQuality) && isWeekFullyCovered(previousWeekDataQuality);
  const percentChange: WeeklyReportPercentChange | null = bothWeeksFullyCovered
    ? {
        views: computePercentChange(syncedVideoTotals.views, previousWeekTotals.views),
        estimatedMinutesWatched: computePercentChange(
          syncedVideoTotals.estimatedMinutesWatched,
          previousWeekTotals.estimatedMinutesWatched
        ),
        subscribersGained: computePercentChange(syncedVideoTotals.subscribersGained, previousWeekTotals.subscribersGained),
        subscribersLost: computePercentChange(syncedVideoTotals.subscribersLost, previousWeekTotals.subscribersLost),
      }
    : null;

  const viewsByVideo = new Map<string, number>();
  for (const record of args.metricRecords) {
    if (record.metricName !== "views") continue;
    if (record.metricDate < args.weekStartDate || record.metricDate > args.weekEndDate) continue;
    viewsByVideo.set(record.videoId, (viewsByVideo.get(record.videoId) ?? 0) + record.metricValue);
  }
  const topContent: WeeklyReportTopContentEntry[] = [...viewsByVideo.entries()]
    .map(([videoId, views]) => ({ videoId, views, title: args.videoTitlesById.get(videoId) ?? videoId }))
    .sort((a, b) => b.views - a.views)
    .slice(0, TOP_CONTENT_LIMIT);

  return {
    reportFormatVersion: WEEKLY_REPORT_FORMAT_VERSION,
    channelId: args.channelId,
    weekStartDate: args.weekStartDate,
    weekEndDate: args.weekEndDate,
    generatedAt: args.now.toISOString(),
    status: isWeekFullyCovered(currentWeekDataQuality) ? "final" : "provisional",
    source: WEEKLY_REPORT_SOURCE_DESCRIPTION,
    metricDefinitions: SYNCED_VIDEO_TOTALS_METRIC_DEFINITIONS,
    syncedVideoTotals,
    previousWeekTotals,
    percentChange,
    currentWeekDataQuality,
    previousWeekDataQuality,
    topContent,
  };
}
