// BL-221 (docs/roadmap/plans/CONTENT_UX_PLAN.md stage A): what Content → «Видео» shows next to each synced video beyond the sync's
// own fields -- the video's kind and its last 7 days. Local reads only (never a YouTube call); a shared read module that depends on
// no feature module (AGENTS.md §M): the live-streams data reaches it as plain ids.

/**
 * `live`: a broadcast on air now. `broadcast`: a broadcast not on air yet (YouTube's own default one, or one set up but never
 * started). `recording`: a finished broadcast the app ran (a 24/7 segment). `video`: anything else.
 */
export type VideoKind = "video" | "live" | "recording" | "broadcast";

export type VideoInsight = {
  kind: VideoKind;
  /** Views over the 7 days ending on `viewsThrough`; null while the channel has no daily views at all. */
  views7d: number | null;
  /** Impressions and click-through rate (0..1) over the 7 days ending on `reachThrough`; null without impressions. */
  impressions7d: number | null;
  ctr7d: number | null;
};

export type VideoInsightsResult = {
  channelId: string;
  videos: Record<string, VideoInsight>;
  /** The newest day of the daily views (YouTube Analytics lags by a day or two); null when none. */
  viewsThrough: string | null;
  /** The newest day of the reach report; null when none. */
  reachThrough: string | null;
};

export type VideoInsightsInput = {
  channelId: string;
  videos: Array<{ videoId: string; liveBroadcastContent: string | null }>;
  /** Every broadcast the app ran on the channel (its segments and sampled broadcasts). */
  appBroadcastIds: readonly string[];
  dailyViews: ReadonlyArray<{ videoId: string; date: string; views: number }>;
  reach: ReadonlyArray<{ videoId: string; date: string; impressions: number; ctr: number | null }>;
  viewsThrough: string | null;
  reachThrough: string | null;
};
