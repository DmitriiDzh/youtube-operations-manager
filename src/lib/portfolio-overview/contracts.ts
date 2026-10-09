/**
 * BL-161 (FO-REQ-0012 §2.3, `docs/roadmap/plans/PRODUCER_ROLE_PLAN.md` §3) -- one row per connected channel for one date range, side
 * by side, from data this device already stores: channel-level analytics (`channel_metrics_daily`), imported Reach reports, synced
 * videos. Never a live YouTube call. A source with nothing stored for the range is reported as such (`null`), never as zero.
 */

export type PortfolioRange = { startDate: string; endDate: string };

/** What the caller loads for one channel; this module only adds it up. */
export type PortfolioChannelSource = {
  channelId: string;
  title: string;
  /** Stored channel-level daily rows within the range. */
  metrics: Array<{ metricDate: string; metricName: string; metricValue: number }>;
  /** Imported Reach data for the range, or null when it could not be read. */
  reach: { state: "no_job" | "waiting_for_first_report" | "ready"; impressions: number; ctr: number | null; coveredThrough: string | null } | null;
  /** `snippet.publishedAt` of every synced video of the channel. */
  videoPublishedAt: string[];
  lastVideoSyncAt: Date | null;
  lastAnalyticsCollectedAt: Date | null;
};

export type PortfolioChannelRow = {
  channelId: string;
  title: string;
  analytics: {
    /** Days in the range with at least one stored channel-level row; 0 = nothing stored, every figure below is null. */
    daysWithData: number;
    views: number | null;
    watchMinutes: number | null;
    subscribersGained: number | null;
    subscribersLost: number | null;
  };
  reach: { state: "no_job" | "waiting_for_first_report" | "ready" | "unavailable"; impressions: number | null; ctr: number | null };
  /** Synced videos published within the range (UTC dates). */
  uploads: number;
  freshness: { lastVideoSyncAt: string | null; lastAnalyticsCollectedAt: string | null; reachCoveredThrough: string | null };
};

export type PortfolioOverview = PortfolioRange & { source: "local"; channels: PortfolioChannelRow[] };
