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
  reach: {
    state: "no_job" | "waiting_for_first_report" | "ready";
    impressions: number;
    ctr: number | null;
    coveredThrough: string | null;
    /** Days within the range with imported Reach rows; 0 = nothing imported for the range (the totals then mean nothing). */
    daysWithData: number;
  } | null;
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
  reach: { state: "no_job" | "waiting_for_first_report" | "ready" | "unavailable"; daysWithData: number; impressions: number | null; ctr: number | null };
  /** Synced videos published within the range (UTC dates); null when the channel's videos were never synced on this device. */
  uploads: number | null;
  freshness: { lastVideoSyncAt: string | null; lastAnalyticsCollectedAt: string | null; reachCoveredThrough: string | null };
};

export type PortfolioOverview = PortfolioRange & { source: "local"; channels: PortfolioChannelRow[] };

/**
 * BL-166 (FO-REQ-0015 item 8, `docs/roadmap/plans/VIDEO_MILESTONES_PLAN.md` §2): for each connected channel, its uploads in a range,
 * each with its day-7 and day-28 milestones -- the stored window totals (as YouTube returned them) and the Reach of the same window.
 * Stored data only, never a live call; no retention curves (`agent_get_video_milestones` has them).
 */
export type UploadMilestoneStatus = "collected" | "retry" | "failed" | "due" | "not_due";

/** A stored milestone as the analytics collection left it. */
export type StoredUploadMilestone = {
  videoId: string;
  milestoneDays: number;
  status: "collected" | "retry" | "failed";
  collectedAt: Date | null;
  views: number | null;
  estimatedMinutesWatched: number | null;
  averageViewDuration: number | null;
  averageViewPercentage: number | null;
};

export type UploadMilestonesDeps = {
  /** The milestones, e.g. [7, 28]. */
  milestoneDays: readonly number[];
  /** A milestone's window for a publish time (YouTube Analytics' Pacific dates, inclusive). */
  windowOf(publishedAt: string, days: number): { windowStart: string; windowEnd: string };
  /** Whether the collection may query that window yet (its reporting lag has passed). */
  isDue(windowEnd: string): boolean;
  listChannels(): Promise<Array<{ channelId: string; title: string }>>;
  /** The channel's synced videos; null when they were never synced on this device. */
  listVideos(channelId: string): Promise<Array<{ videoId: string; title: string; publishedAt: string | null; durationSeconds: number | null }> | null>;
  listStoredMilestones(channelId: string): Promise<StoredUploadMilestone[]>;
  /** Reach of each video over its own window, or null when it could not be read. */
  readReach(
    channelId: string,
    windows: Array<{ videoId: string; startDate: string; endDate: string }>
  ): Promise<{
    state: "no_job" | "waiting_for_first_report" | "ready";
    windows: Array<{ videoId: string; startDate: string; endDate: string; daysWithData: number; impressions: number; ctr: number | null }>;
  } | null>;
};

export type UploadMilestoneView = {
  milestoneDays: number;
  windowStart: string;
  windowEnd: string;
  /**
   * `collected`; `retry` (a query failed, tried again on a later run); `failed` (given up after its attempts); `due` (waiting for its
   * collection run); `not_due` (the window or its reporting lag is not over yet).
   */
  status: UploadMilestoneStatus;
  collectedAt: string | null;
  /** As YouTube returned them for the window; null unless `collected`. */
  totals: { views: number | null; estimatedMinutesWatched: number | null; averageViewDuration: number | null; averageViewPercentage: number | null } | null;
  /** Imported Reach over the window: impressions summed, CTR impressions-weighted; both null when no Reach day is stored in it. */
  reach: { daysWithData: number; impressions: number | null; ctr: number | null };
};

export type UploadMilestonesUpload = {
  videoId: string;
  title: string;
  publishedAt: string;
  durationSeconds: number | null;
  milestones: UploadMilestoneView[];
};

export type UploadMilestonesChannel = {
  channelId: string;
  title: string;
  reachState: "no_job" | "waiting_for_first_report" | "ready" | "unavailable";
  /** Uploads published in the range (UTC dates, like the portfolio overview), oldest first; null when never synced here. */
  uploads: UploadMilestonesUpload[] | null;
};

export type UploadMilestones = PortfolioRange & { source: "local"; channels: UploadMilestonesChannel[] };
