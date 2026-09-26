import {
  DomainError,
  isDomainError,
  type CredentialRef,
  type DomainErrorCode,
  type DomainErrorShape,
  type ResolvedCredentials,
} from "@/lib/video-metadata/contracts";
import type { WeeklyReportContent } from "./weekly-report";

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
 * genuinely unavailable via the `youtubeAnalytics/v2 reports:query` endpoint this app's gateway
 * uses, though not for the reason first assumed here. **Follow-up (docs/roadmap/plans/
 * ANALYTICS_TAB_DEEP_PARITY_PLAN.md §0, BL-093, 2026-09-25):** those two exact names were simply
 * wrong -- the real identifiers are `videoThumbnailImpressions`/
 * `videoThumbnailImpressionsClickThroughRate`, added to the public API 2026-01-15. A follow-up
 * live probe confirmed those two names ARE recognized by the API, but every query shape tried
 * against this same `reports:query` endpoint (channel-level, per-day, per-video, alone or paired
 * with `views`) returned "The query is not supported," not a metric-name error -- these two
 * metrics belong to a separate "Reach report" family (`channel_reach_basic_a1`/
 * `channel_reach_combined_a1`) that only exists under the YouTube *Reporting* API v1's bulk,
 * scheduled-job system, never this ad-hoc query endpoint. The original "genuinely unavailable"
 * conclusion holds for this endpoint specifically; it was never really about the metric name.
 */
export const CHANNEL_OVERVIEW_METRIC_NAMES = [
  "views",
  "estimatedMinutesWatched",
  "subscribersGained",
  "subscribersLost",
] as const;

export type ChannelOverviewMetricName = (typeof CHANNEL_OVERVIEW_METRIC_NAMES)[number];

/**
 * Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §3.4/§4.4,
 * slices C2/A2/A3/A4/A6) -- the exact `dimensions`/`metricNames` request shape for each channel-
 * level breakdown card, confirmed against real API responses for every one of these six kinds
 * (BL-093/BL-094 live probe, 2026-09-25) before this constant was written. One shared preset table
 * rather than one bespoke service method per card -- every breakdown card uses the identical
 * `getChannelBreakdown` service method and `queryChannelBreakdownReport` gateway function below,
 * parameterized only by which preset to use.
 */
export const CHANNEL_BREAKDOWN_PRESETS = {
  trafficSources: { dimensions: "insightTrafficSourceType", metricNames: ["views"] },
  deviceType: { dimensions: "deviceType", metricNames: ["estimatedMinutesWatched"] },
  ageGender: { dimensions: "ageGroup,gender", metricNames: ["viewerPercentage"] },
  geography: { dimensions: "country", metricNames: ["views"] },
  subscribedStatus: { dimensions: "subscribedStatus", metricNames: ["estimatedMinutesWatched"] },
  contentFormat: { dimensions: "creatorContentType", metricNames: ["estimatedMinutesWatched"] },
} as const satisfies Record<string, { dimensions: string; metricNames: readonly string[] }>;

export type ChannelBreakdownKind = keyof typeof CHANNEL_BREAKDOWN_PRESETS;

export type ChannelBreakdownRow = {
  dimensionValues: string[];
  metrics: Record<string, number>;
};

export type GetChannelBreakdownResult = {
  channelId: string;
  breakdown: ChannelBreakdownKind;
  startDate: string;
  endDate: string;
  rows: ChannelBreakdownRow[];
};

/**
 * Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §3.4, Slice
 * C4, "Intro" mode) -- one point per `elapsedVideoTimeRatio` value the API returns (confirmed
 * against a real response, BL-093). Deliberately scoped to just the raw curve for now, not
 * Studio's own "This video vs. typical retention" two-series comparison or its Top
 * moments/Spikes/Dips classification -- the exact relationship between `audienceWatchRatio` and
 * `relativeRetentionPerformance` needed to reconstruct Studio's own "typical" baseline was never
 * confirmed this session; inventing one would be exactly the "reading the implementation and
 * writing down what it happens to do" `AGENTS.md` §L warns against, applied to an external API
 * instead of this app's own code.
 */
export type VideoRetentionPoint = {
  elapsedVideoTimeRatio: number;
  audienceWatchRatio: number;
  relativeRetentionPerformance: number;
};

export type GetVideoRetentionCurveResult = {
  channelId: string;
  videoId: string;
  startDate: string;
  endDate: string;
  points: VideoRetentionPoint[];
};

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

export type WeeklyReportSummary = {
  channelId: string;
  weekStartDate: string;
  weekEndDate: string;
  status: string;
  generatedAt: string;
  report: WeeklyReportContent;
};

export type ListWeeklyReportsResult = {
  channelId: string;
  reports: WeeklyReportSummary[];
};

export type GetWeeklyReportResult = {
  channelId: string;
  report: WeeklyReportSummary | null;
};

export type RunWeeklyReportIfDueResult =
  | { generated: false }
  | { generated: true; report: WeeklyReportSummary };
