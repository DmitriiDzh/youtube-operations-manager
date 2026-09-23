"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { computePercentChange } from "@/lib/analytics/period";
import { AnalyticsLineChart } from "./analytics-line-chart";
import { MetricDelta } from "./metric-delta";

type SyncedChannel = {
  channelId: string;
  title: string;
};

type ChannelOverview = {
  channelId: string;
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  daily: Array<{
    date: string;
    views: number;
    estimatedMinutesWatched: number;
    subscribersGained: number;
    subscribersLost: number;
  }>;
  currentTotals: {
    views: number;
    estimatedMinutesWatched: number;
    subscribersGained: number;
    subscribersLost: number;
  };
  previousTotals: {
    views: number;
    estimatedMinutesWatched: number;
    subscribersGained: number;
    subscribersLost: number;
  };
};

type MetricRow = {
  videoId: string;
  metricDate: string;
  metricName: string;
  metricValue: number;
};

type SyncedVideo = {
  videoId: string;
  title: string;
  thumbnails: Record<string, { url: string }>;
};

const PERIOD_OPTIONS = [
  { days: 7, label: "Last 7 days" },
  { days: 28, label: "Last 28 days" },
  { days: 90, label: "Last 90 days" },
  { days: 365, label: "Last 365 days" },
] as const;

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Ends yesterday, matching analytics-manager.tsx's own default range -- the Analytics API's
// day-dimension reports never include the most recent day(s) yet.
function computeRange(periodDays: number): { startDate: string; endDate: string } {
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (periodDays - 1));
  return { startDate: formatLocalDate(start), endDate: formatLocalDate(end) };
}

function formatHours(minutes: number): string {
  return (minutes / 60).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function ChannelOverviewPanel({ subscriberCount }: { subscriberCount?: string }) {
  const [channel, setChannel] = useState<SyncedChannel | null>(null);
  const [loadingChannel, setLoadingChannel] = useState(true);
  const [periodDays, setPeriodDays] = useState<number>(28);

  const [overview, setOverview] = useState<ChannelOverview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [topContent, setTopContent] = useState<Array<{ videoId: string; title: string; thumbnail: string | null; views: number }>>([]);
  const [loadingTopContent, setLoadingTopContent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingChannel(true);
      try {
        const res = await fetch("/api/channels");
        const data = await res.json();
        if (cancelled || !res.ok || !Array.isArray(data.channels)) return;
        const active = (data.channels as SyncedChannel[])[0];
        if (active) setChannel(active);
      } finally {
        if (!cancelled) setLoadingChannel(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchOverview = useCallback(async (channelId: string, days: number) => {
    setLoadingOverview(true);
    setOverviewError(null);
    try {
      const { startDate, endDate } = computeRange(days);
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/analytics/overview?startDate=${startDate}&endDate=${endDate}`
      );
      const data = await res.json();
      if (!res.ok) {
        setOverviewError(data.message ?? "Failed to load channel analytics");
        setOverview(null);
        return;
      }
      setOverview(data as ChannelOverview);
    } catch {
      setOverviewError("Failed to load channel analytics");
      setOverview(null);
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  const fetchTopContent = useCallback(async (channelId: string, days: number) => {
    setLoadingTopContent(true);
    try {
      const { startDate, endDate } = computeRange(days);
      const [metricsRes, videosRes] = await Promise.all([
        fetch(`/api/channels/${encodeURIComponent(channelId)}/analytics`),
        fetch(`/api/channels/${encodeURIComponent(channelId)}/videos`),
      ]);
      const metricsData = await metricsRes.json();
      const videosData = await videosRes.json();
      if (!metricsRes.ok || !videosRes.ok || !Array.isArray(metricsData.rows) || !Array.isArray(videosData.videos)) {
        setTopContent([]);
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
        .slice(0, 5);

      setTopContent(ranked);
    } finally {
      setLoadingTopContent(false);
    }
  }, []);

  useEffect(() => {
    if (!channel) return;
    void fetchOverview(channel.channelId, periodDays);
    void fetchTopContent(channel.channelId, periodDays);
  }, [channel, periodDays, fetchOverview, fetchTopContent]);

  const chartData = useMemo(
    () => overview?.daily.map((row) => ({ date: row.date, value: row.views })) ?? [],
    [overview]
  );

  const periodLabel = PERIOD_OPTIONS.find((p) => p.days === periodDays)?.label.toLowerCase().replace("last ", "previous ") ?? "previous period";

  if (loadingChannel) {
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-zinc-300">Overview</h3>
        <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
          {PERIOD_OPTIONS.map((option) => (
            <button
              key={option.days}
              onClick={() => setPeriodDays(option.days)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                periodDays === option.days ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {overviewError && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">{overviewError}</div>
      )}

      {loadingOverview && !overview ? (
        <p className="text-sm text-zinc-400">Loading...</p>
      ) : overview ? (
        <>
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800 sm:grid-cols-3">
            <div className="space-y-1 bg-zinc-900 p-4">
              <div className="text-xs text-zinc-500">Views</div>
              <div className="text-2xl font-semibold text-zinc-100">{overview.currentTotals.views.toLocaleString()}</div>
              <MetricDelta
                percent={computePercentChange(overview.currentTotals.views, overview.previousTotals.views)}
                periodLabel={periodLabel}
              />
            </div>
            <div className="space-y-1 bg-zinc-900 p-4">
              <div className="text-xs text-zinc-500">Watch time (hours)</div>
              <div className="text-2xl font-semibold text-zinc-100">
                {formatHours(overview.currentTotals.estimatedMinutesWatched)}
              </div>
              <MetricDelta
                percent={computePercentChange(
                  overview.currentTotals.estimatedMinutesWatched,
                  overview.previousTotals.estimatedMinutesWatched
                )}
                periodLabel={periodLabel}
              />
            </div>
            <div className="space-y-1 bg-zinc-900 p-4">
              <div className="text-xs text-zinc-500">Subscribers</div>
              <div className="text-2xl font-semibold text-zinc-100">
                {(() => {
                  const net = overview.currentTotals.subscribersGained - overview.currentTotals.subscribersLost;
                  return `${net >= 0 ? "+" : ""}${net.toLocaleString()}`;
                })()}
              </div>
              <MetricDelta
                percent={computePercentChange(
                  overview.currentTotals.subscribersGained - overview.currentTotals.subscribersLost,
                  overview.previousTotals.subscribersGained - overview.previousTotals.subscribersLost
                )}
                periodLabel={periodLabel}
              />
            </div>
          </div>

          {subscriberCount && (
            <p className="text-xs text-zinc-500">
              Current subscribers (all-time): <span className="text-zinc-300">{Number(subscriberCount).toLocaleString()}</span>
            </p>
          )}

          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <AnalyticsLineChart data={chartData} formatValue={(v) => `${v.toLocaleString()} views`} />
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <h4 className="mb-3 text-sm font-medium text-zinc-300">Top content, this period</h4>
            {loadingTopContent ? (
              <p className="text-sm text-zinc-500">Loading...</p>
            ) : topContent.length === 0 ? (
              <p className="text-sm text-zinc-500">
                No collected data for this period yet — use &ldquo;Collect now&rdquo; below to fetch it.
              </p>
            ) : (
              <ul className="space-y-2">
                {topContent.map((item) => (
                  <li key={item.videoId} className="flex items-center gap-3 text-sm">
                    {item.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.thumbnail} alt="" className="h-9 w-16 rounded object-cover" />
                    ) : (
                      <div className="h-9 w-16 rounded bg-zinc-800" />
                    )}
                    <span className="flex-1 truncate text-zinc-300">{item.title}</span>
                    <span className="text-zinc-400">{item.views.toLocaleString()} views</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
