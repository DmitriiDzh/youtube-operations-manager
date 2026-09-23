"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type SyncedChannel = {
  channelId: string;
  title: string;
};

type SyncedVideo = {
  videoId: string;
  title: string;
  publishedAt: string;
  thumbnails: Record<string, { url: string }>;
  viewCount: number | null;
  commentCount: number | null;
  likeCount: number | null;
};

type MetricRow = {
  videoId: string;
  metricDate: string;
  metricName: string;
  metricValue: number;
};

type ChannelOverviewTotals = {
  views: number;
  estimatedMinutesWatched: number;
  subscribersGained: number;
  subscribersLost: number;
};

type ChannelOverview = {
  currentTotals: ChannelOverviewTotals;
  previousTotals: ChannelOverviewTotals;
};

const RECENT_VIDEO_COUNT = 10;
const PUBLISHED_LIST_COUNT = 5;

function formatCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

function formatTimeSincePublish(publishedAt: string): string {
  const publishedMs = new Date(publishedAt).getTime();
  const days = Math.floor((Date.now() - publishedMs) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "Published today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

function formatAverageDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatHours(minutes: number): string {
  return (minutes / 60).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

// Fixed at 28 days, matching real Studio's own Home "Channel analytics" card (live-verified
// 2026-09-23: "Summary, Last 28 days") -- unlike the Analytics tab's own adjustable period
// picker, Home's summary is not user-configurable in Studio either.
const HOME_SUMMARY_PERIOD_DAYS = 28;

function computeRange(days: number): { startDate: string; endDate: string } {
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { startDate: fmt(start), endDate: fmt(end) };
}

export function HomeDashboardPanel({
  subscriberCount,
  onViewAllContent,
}: {
  subscriberCount?: string;
  onViewAllContent?: () => void;
}) {
  const [channel, setChannel] = useState<SyncedChannel | null>(null);
  const [loading, setLoading] = useState(true);
  const [videos, setVideos] = useState<SyncedVideo[]>([]);
  const [metricRows, setMetricRows] = useState<MetricRow[]>([]);
  const [overview, setOverview] = useState<ChannelOverview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);

  // Deliberately two independent fetches, not one sequential `fetchAll` (advisor review, §M):
  // the "Latest video performance"/"Published videos" cards depend only on `videos`/`analytics`
  // (Data API-backed, already-synced local data) and must render even when the live Analytics
  // API overview call is slow, fails, or is disabled (Settings -> "Analytics reads" toggle) --
  // Home is a large feature module, and the rest of it must keep working when one dependency of
  // it is unavailable. Verified live: with Analytics reads switched off, Home's video cards still
  // render normally and only the "Channel analytics" card shows its own unavailable-state message.
  const fetchVideosAndMetrics = useCallback(async (channelId: string) => {
    const [videosRes, metricsRes] = await Promise.all([
      fetch(`/api/channels/${encodeURIComponent(channelId)}/videos`),
      fetch(`/api/channels/${encodeURIComponent(channelId)}/analytics`),
    ]);
    const videosData = await videosRes.json();
    const metricsData = await metricsRes.json();
    if (videosRes.ok && Array.isArray(videosData.videos)) setVideos(videosData.videos);
    if (metricsRes.ok && Array.isArray(metricsData.rows)) setMetricRows(metricsData.rows);
  }, []);

  const fetchOverview = useCallback(async (channelId: string) => {
    setLoadingOverview(true);
    try {
      const { startDate, endDate } = computeRange(HOME_SUMMARY_PERIOD_DAYS);
      const overviewRes = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/analytics/overview?startDate=${startDate}&endDate=${endDate}`
      );
      const overviewData = await overviewRes.json();
      if (overviewRes.ok) setOverview(overviewData as ChannelOverview);
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/channels");
        const data = await res.json();
        if (cancelled || !res.ok || !Array.isArray(data.channels)) return;
        const active = (data.channels as SyncedChannel[])[0];
        if (!active) return;
        setChannel(active);
        await fetchVideosAndMetrics(active.channelId);
        if (!cancelled) void fetchOverview(active.channelId);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recentVideos = useMemo(
    () =>
      [...videos]
        .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
        .slice(0, RECENT_VIDEO_COUNT),
    [videos]
  );
  const latestVideo = recentVideos[0] ?? null;

  const ranking = useMemo(() => {
    if (!latestVideo) return null;
    const sorted = [...recentVideos].sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0));
    const index = sorted.findIndex((v) => v.videoId === latestVideo.videoId);
    return index < 0 ? null : { rank: index + 1, of: sorted.length };
  }, [recentVideos, latestVideo]);

  const latestVideoAvgDuration = useMemo(() => {
    if (!latestVideo) return null;
    const durations = metricRows
      .filter((r) => r.videoId === latestVideo.videoId && r.metricName === "averageViewDuration")
      .map((r) => r.metricValue);
    if (durations.length === 0) return null;
    return durations.reduce((sum, v) => sum + v, 0) / durations.length;
  }, [metricRows, latestVideo]);

  if (loading) {
    return <p className="text-sm text-zinc-400">Loading...</p>;
  }

  if (!channel) {
    return (
      <p className="text-sm text-zinc-400">
        No channel synchronized yet — sign in and sync a channel in the Content tab first.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h3 className="mb-3 text-sm font-medium text-zinc-300">Latest video performance</h3>
          {!latestVideo ? (
            <p className="text-sm text-zinc-500">No synced videos yet.</p>
          ) : (
            <div className="space-y-3">
              <div className="flex gap-3">
                {Object.values(latestVideo.thumbnails)[0]?.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={Object.values(latestVideo.thumbnails)[0].url}
                    alt=""
                    className="h-20 w-36 rounded-lg object-cover"
                  />
                ) : (
                  <div className="h-20 w-36 rounded-lg bg-zinc-800" />
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-sm font-medium text-zinc-100">{latestVideo.title}</p>
                  <p className="text-xs text-zinc-500">{formatTimeSincePublish(latestVideo.publishedAt)}</p>
                  <div className="flex gap-3 text-xs text-zinc-400">
                    <span>{formatCount(latestVideo.viewCount)} views</span>
                    <span>{formatCount(latestVideo.commentCount)} comments</span>
                    <span>{formatCount(latestVideo.likeCount)} likes</span>
                  </div>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                {ranking && (
                  <div className="rounded-lg bg-zinc-800/60 p-2">
                    <dt className="text-zinc-500">Ranking by views</dt>
                    <dd className="text-zinc-200">
                      {ranking.rank} of {ranking.of}
                    </dd>
                  </div>
                )}
                {latestVideoAvgDuration !== null && (
                  <div className="rounded-lg bg-zinc-800/60 p-2">
                    <dt className="text-zinc-500">Average view duration</dt>
                    <dd className="text-zinc-200">{formatAverageDuration(latestVideoAvgDuration)}</dd>
                  </div>
                )}
              </dl>
              {/* Thumbnail click-through rate is deliberately not shown here -- live-confirmed
                  2026-09-23 that the Analytics API rejects "impressions"/"impressionClickThroughRate"
                  as unknown metric identifiers; Studio computes this from data this app cannot
                  reach via the public API (see channel-overview-panel.tsx's sibling doc comment,
                  and STUDIO_PARITY_PLAN.md §4). */}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-300">Published videos</h3>
            {onViewAllContent && (
              <button onClick={onViewAllContent} className="text-xs text-indigo-400 hover:text-indigo-300">
                View all
              </button>
            )}
          </div>
          {recentVideos.length === 0 ? (
            <p className="text-sm text-zinc-500">No synced videos yet.</p>
          ) : (
            <ul className="space-y-2">
              {recentVideos.slice(0, PUBLISHED_LIST_COUNT).map((video) => (
                <li key={video.videoId} className="flex items-center gap-3 text-sm">
                  {Object.values(video.thumbnails)[0]?.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={Object.values(video.thumbnails)[0].url}
                      alt=""
                      className="h-9 w-16 rounded object-cover"
                    />
                  ) : (
                    <div className="h-9 w-16 rounded bg-zinc-800" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-zinc-300">{video.title}</span>
                  <span className="shrink-0 text-xs text-zinc-500">
                    {formatCount(video.viewCount)} · {formatCount(video.commentCount)} · {formatCount(video.likeCount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-3 text-sm font-medium text-zinc-300">Channel analytics</h3>
        <div className="space-y-1">
          <div className="text-xs text-zinc-500">Current subscribers</div>
          <div className="text-2xl font-semibold text-zinc-100">
            {subscriberCount ? Number(subscriberCount).toLocaleString() : "—"}
          </div>
          {overview &&
            (() => {
              const netNew = overview.currentTotals.subscribersGained - overview.currentTotals.subscribersLost;
              // Absolute net-new count, not a percentage -- matches real Studio's own Home card
              // exactly ("+18 in last 28 days", live-verified 2026-09-23), which is deliberately
              // different from the Analytics tab's own Subscribers card (percent-vs-previous-period,
              // see channel-overview-panel.tsx). A percentage here would describe how much the net-new
              // *count* itself changed period-over-period, not how "Current subscribers" (the number
              // directly above it) changed -- those are two different facts, and showing the former
              // right under the latter reads as a claim about the latter.
              return (
                <p className="text-xs text-zinc-500">
                  <span className={netNew >= 0 ? "text-green-400" : "text-red-400"}>
                    {netNew >= 0 ? "+" : ""}
                    {netNew.toLocaleString()}
                  </span>{" "}
                  in last 28 days
                </p>
              );
            })()}
        </div>

        {overview ? (
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-zinc-800 pt-4 text-sm">
            <div>
              <div className="text-xs text-zinc-500">Views, last 28 days</div>
              <div className="font-medium text-zinc-100">{overview.currentTotals.views.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Watch time (hours), last 28 days</div>
              <div className="font-medium text-zinc-100">{formatHours(overview.currentTotals.estimatedMinutesWatched)}</div>
            </div>
          </div>
        ) : loadingOverview ? (
          <p className="mt-4 border-t border-zinc-800 pt-4 text-xs text-zinc-500">Loading...</p>
        ) : (
          <p className="mt-4 border-t border-zinc-800 pt-4 text-xs text-zinc-500">
            Analytics summary unavailable -- Analytics reads may be disabled, or nothing has been
            collected yet.
          </p>
        )}

        {/* Comments feed and Recent-subscribers feed (real Studio's Home also shows these) are
            deliberately not built here yet -- neither has confirmed public-API feasibility
            (docs/roadmap/plans/STUDIO_PARITY_PLAN.md §5, open question 4). */}
      </div>
    </div>
  );
}
