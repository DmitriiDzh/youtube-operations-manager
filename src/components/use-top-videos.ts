import { useCallback, useEffect, useState } from "react";
import { computeDefaultPeriodRange } from "@/lib/analytics/period";

type MetricRow = { videoId: string; metricDate: string; metricName: string; metricValue: number };
type SyncedVideo = { videoId: string; title: string; thumbnails: Record<string, { url: string }> };

export type TopVideoRow = { videoId: string; title: string; thumbnail: string | null; views: number };

/**
 * Ranks this channel's already-locally-collected videos by views in the selected period --
 * extracted from `channel-overview-panel.tsx`'s own original inline `fetchTopContent` (Slice C5,
 * docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §3.4) so the Content tab's own "Top videos"
 * card can reuse the identical ranking logic (AGENTS.md §D) rather than a second copy. A local
 * read over already-collected `video_metrics_daily` rows, not a live Analytics API call -- same
 * data source Overview's own "Top content, this period" list already reads from.
 */
export function useTopVideos(channelId: string | null, periodDays: number, limit = 5) {
  const [topVideos, setTopVideos] = useState<TopVideoRow[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchTopVideos = useCallback(async () => {
    if (!channelId) return;
    setLoading(true);
    try {
      const { startDate, endDate } = computeDefaultPeriodRange(periodDays);
      const [metricsRes, videosRes] = await Promise.all([
        fetch(`/api/channels/${encodeURIComponent(channelId)}/analytics`),
        fetch(`/api/channels/${encodeURIComponent(channelId)}/videos`),
      ]);
      const metricsData = await metricsRes.json();
      const videosData = await videosRes.json();
      if (!metricsRes.ok || !videosRes.ok || !Array.isArray(metricsData.rows) || !Array.isArray(videosData.videos)) {
        setTopVideos([]);
        return;
      }

      const viewsByVideo = new Map<string, number>();
      for (const row of metricsData.rows as MetricRow[]) {
        if (row.metricName !== "views") continue;
        if (row.metricDate < startDate || row.metricDate > endDate) continue;
        viewsByVideo.set(row.videoId, (viewsByVideo.get(row.videoId) ?? 0) + row.metricValue);
      }

      const videosById = new Map((videosData.videos as SyncedVideo[]).map((v) => [v.videoId, v]));
      const ranked = [...viewsByVideo.entries()]
        .map(([videoId, views]) => ({
          videoId,
          views,
          title: videosById.get(videoId)?.title ?? videoId,
          thumbnail: Object.values(videosById.get(videoId)?.thumbnails ?? {})[0]?.url ?? null,
        }))
        .sort((a, b) => b.views - a.views)
        .slice(0, limit);

      setTopVideos(ranked);
    } finally {
      setLoading(false);
    }
  }, [channelId, periodDays, limit]);

  useEffect(() => {
    void fetchTopVideos();
  }, [fetchTopVideos]);

  return { topVideos, loading, refetch: fetchTopVideos };
}
