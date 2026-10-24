import type { VideoInsight, VideoInsightsInput, VideoInsightsResult, VideoKind } from "./contracts";

/** The first day of the 7-day window that ends on `through` (both YYYY-MM-DD, UTC). */
export function windowStart(through: string): string {
  const end = Date.parse(`${through}T00:00:00Z`);
  return new Date(end - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function kindOf(liveBroadcastContent: string | null, ranByApp: boolean): VideoKind {
  if (liveBroadcastContent === "live") return "live";
  if (liveBroadcastContent === "upcoming") return "broadcast";
  return ranByApp ? "recording" : "video";
}

/** BL-221: each synced video's kind and its last 7 days of views and reach (CONTENT_UX_PLAN.md stage A). Pure. */
export function buildVideoInsights(input: VideoInsightsInput): VideoInsightsResult {
  const ran = new Set(input.appBroadcastIds);
  const viewsFrom = input.viewsThrough ? windowStart(input.viewsThrough) : null;
  const reachFrom = input.reachThrough ? windowStart(input.reachThrough) : null;
  const views = new Map<string, number>();
  if (viewsFrom && input.viewsThrough) {
    for (const row of input.dailyViews) {
      if (row.date < viewsFrom || row.date > input.viewsThrough) continue;
      views.set(row.videoId, (views.get(row.videoId) ?? 0) + row.views);
    }
  }
  const reach = new Map<string, { impressions: number; clicks: number; rated: number }>();
  if (reachFrom && input.reachThrough) {
    for (const row of input.reach) {
      if (row.date < reachFrom || row.date > input.reachThrough) continue;
      const r = reach.get(row.videoId) ?? { impressions: 0, clicks: 0, rated: 0 };
      r.impressions += row.impressions;
      if (row.ctr !== null) {
        r.clicks += row.impressions * row.ctr;
        r.rated += row.impressions;
      }
      reach.set(row.videoId, r);
    }
  }
  const videos: Record<string, VideoInsight> = {};
  for (const video of input.videos) {
    const r = reach.get(video.videoId);
    videos[video.videoId] = {
      kind: kindOf(video.liveBroadcastContent, ran.has(video.videoId)),
      views7d: input.viewsThrough ? (views.get(video.videoId) ?? 0) : null,
      impressions7d: r ? r.impressions : null,
      ctr7d: r && r.rated > 0 ? r.clicks / r.rated : null,
    };
  }
  return { channelId: input.channelId, videos, viewsThrough: input.viewsThrough, reachThrough: input.reachThrough };
}
