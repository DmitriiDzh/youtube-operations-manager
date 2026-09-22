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
 * Phase 8 (BL-052, docs/roadmap/plans/PHASE_8_PLAN.md §10 item 2) -- every metric
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
 * BL-054 (docs/roadmap/plans/PHASE_8_PLAN.md §10 item 5) -- the date range an *unattended* daily
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
