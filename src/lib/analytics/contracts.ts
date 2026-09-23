import {
  DomainError,
  isDomainError,
  type CredentialRef,
  type DomainErrorCode,
  type DomainErrorShape,
  type ResolvedCredentials,
} from "@/lib/video-metadata/contracts";

export type { CredentialRef, DomainErrorCode, DomainErrorShape, ResolvedCredentials };
export { DomainError, isDomainError };

/**
 * Phase 8 (BL-057, docs/roadmap/plans/PHASE_8_PLAN.md §10 item 2) -- every metric
 * `yt-analytics.readonly` covers, deliberately EXCLUDING every monetary metric (those require
 * the separate `yt-analytics-monetary.readonly` scope and YouTube Partner Program / CMS access,
 * neither requested nor approved). **Provenance note:** captured from an automated
 * fetch-and-summarize pass over the official "Available Reports"/metrics docs on 2026-09-22, not
 * independently confirmed metric-by-metric against the API reference or a real response -- the
 * same honest-capture discipline `src/lib/youtube-supported-languages.ts` already uses for its
 * own hardcoded list. Treat this as the starting hypothesis for what to request, not a verified
 * enumeration: `collectMetrics` isolates a per-video failure (see `services.ts`), so a name the
 * real API rejects fails only that one video's collection for that run, never the whole channel.
 */
export const ANALYTICS_METRIC_NAMES = [
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
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
  "subscribersLost",
  "annotationClickThroughRate",
  "annotationCloseRate",
  "annotationImpressions",
  "annotationClickableImpressions",
  "annotationClosableImpressions",
  "annotationClicks",
  "annotationCloses",
  "cardClickRate",
  "cardTeaserClickRate",
  "cardImpressions",
  "cardTeaserImpressions",
  "cardClicks",
  "cardTeaserClicks",
] as const;

export type AnalyticsMetricName = (typeof ANALYTICS_METRIC_NAMES)[number];

export type CollectMetricsResult = {
  channelId: string;
  startDate: string;
  endDate: string;
  /** How many locally-synced videos this run attempted to collect for. */
  videoCount: number;
  /**
   * How many `upsertMetric` calls this run issued -- counts attempts, not distinct rows. A
   * date/metric already collected in an earlier run still counts here when re-collected (the
   * underlying row is overwritten, not duplicated, at the DB layer -- see `upsertVideoMetric`),
   * so re-running an already-collected range reports a nonzero count even though no new row was
   * created.
   */
  upsertsIssued: number;
  /**
   * Video ids this run could not collect for (the Analytics API call for that one video threw --
   * e.g. an invalid metric name, a transient error). Isolated per-video so one bad video never
   * fails the whole channel's collection run.
   */
  skippedVideoIds: string[];
};

export type StoredVideoMetricRow = {
  videoId: string;
  metricDate: string;
  metricName: string;
  metricValue: number;
};

export type ListMetricsResult = {
  channelId: string;
  rows: StoredVideoMetricRow[];
};

/**
 * BL-059 (docs/roadmap/plans/PHASE_8_PLAN.md §10 item 5) -- the date range an *unattended* daily
 * auto-collection run picks, since (unlike the manual "Collect now" trigger) there is no operator
 * to ask. Matches the manual UI's own default window exactly (`analytics-manager.tsx`'s
 * `defaultDateRange`) -- 7 days, ending yesterday (the Analytics API's own documented behavior is
 * that a `day`-dimension query never returns the most recent day(s) yet, so ending "today" would
 * make every auto-run look like it silently returned less than requested).
 */
export const AUTO_COLLECTION_RANGE_DAYS = 7;

export type AutoCollectResult =
  | { ranCollection: false }
  | { ranCollection: true; result: CollectMetricsResult };

/**
 * Studio-Parity S6b (docs/roadmap/plans/STUDIO_PARITY_PLAN.md §4) -- the small, **live-verified**
 * subset of `ANALYTICS_METRIC_NAMES` a channel-level (no video filter) report actually accepts.
 * Deliberately its own list, not a slice of `ANALYTICS_METRIC_NAMES` picked by convention: this
 * one has been confirmed to work at the channel level against a real response (2026-09-23, see
 * `youtube-read-gateway/analytics-api.ts`'s `queryChannelAnalyticsReport` doc comment), unlike the
 * rest of that list, whose own doc comment says it was never independently confirmed metric-by-
 * metric. "impressions"/"impressionClickThroughRate" (Studio's thumbnail-impressions/CTR widgets)
 * were also live-probed and confirmed **rejected** by the real API ("Unknown identifier") --
 * genuinely unavailable via the public Analytics API, not merely unimplemented here.
 */
export const CHANNEL_OVERVIEW_METRIC_NAMES = [
  "views",
  "estimatedMinutesWatched",
  "subscribersGained",
  "subscribersLost",
] as const;

export type ChannelOverviewMetricName = (typeof CHANNEL_OVERVIEW_METRIC_NAMES)[number];

export type ChannelOverviewDailyRow = {
  date: string;
  views: number;
  estimatedMinutesWatched: number;
  subscribersGained: number;
  subscribersLost: number;
};

export type ChannelOverviewTotals = {
  views: number;
  estimatedMinutesWatched: number;
  subscribersGained: number;
  subscribersLost: number;
};

export type GetChannelOverviewResult = {
  channelId: string;
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  daily: ChannelOverviewDailyRow[];
  currentTotals: ChannelOverviewTotals;
  previousTotals: ChannelOverviewTotals;
};

export type DataQualityVideoSkip = {
  videoId: string;
  skipCount: number;
  lastSkippedAt: string;
};

export type DataQualityReportResult = {
  channelId: string;
  startDate: string;
  endDate: string;
  coveredDates: string[];
  uncoveredDates: string[];
  tooRecentDates: string[];
  videosWithSkips: DataQualityVideoSkip[];
};

export type ComparableAgeVideoSeries = {
  videoId: string;
  title: string;
  publishedAt: string;
  publishDatePacific: string;
  points: Array<{ dayOffset: number; value: number }>;
  cumulativePoints: Array<{ dayOffset: number; cumulativeValue: number }>;
};

export type GetComparableAgeComparisonResult = {
  channelId: string;
  metricName: string;
  maxDays: number;
  videos: ComparableAgeVideoSeries[];
};
