"use client";

import { useEffect, useState } from "react";
import { computeDefaultPeriodRange } from "@/lib/analytics/period";
import { AnalyticsBreakdownCard } from "./analytics-breakdown-card";
import { AnalyticsLineChart } from "./analytics-line-chart";
import { labelTrafficSource } from "@/lib/analytics/breakdown-labels";
import { useTopVideos } from "./use-top-videos";

type SyncedChannel = { channelId: string; title: string };
type RetentionPoint = { elapsedVideoTimeRatio: number; audienceWatchRatio: number; relativeRetentionPerformance: number };

const PERIOD_OPTIONS = [
  { days: 7, label: "Last 7 days" },
  { days: 28, label: "Last 28 days" },
  { days: 90, label: "Last 90 days" },
  { days: 365, label: "Last 365 days" },
] as const;

/**
 * Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §3.4) --
 * Analytics -> Content sub-tab. Starts with Slice C2 (traffic sources); C4 (retention curve) and
 * C5 (top videos) are follow-up additions to this same panel, not a redesign of it.
 */
export function ContentAnalyticsPanel() {
  const [channel, setChannel] = useState<SyncedChannel | null>(null);
  const [loadingChannel, setLoadingChannel] = useState(true);
  const [periodDays, setPeriodDays] = useState<number>(28);
  const { topVideos, loading: loadingTopVideos } = useTopVideos(channel?.channelId ?? null, periodDays, 10);

  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [retentionPoints, setRetentionPoints] = useState<RetentionPoint[] | null>(null);
  const [retentionError, setRetentionError] = useState<string | null>(null);

  // Independent review round 1 finding (2026-09-26): a `cancelled` guard is required here, same as
  // `AnalyticsBreakdownCard` already has -- without it, switching the selected video or period
  // quickly enough could let an older in-flight response overwrite a newer one's curve.
  useEffect(() => {
    if (!channel || !selectedVideoId) return;
    let cancelled = false;
    setRetentionPoints(null);
    setRetentionError(null);
    (async () => {
      try {
        const { startDate, endDate } = computeDefaultPeriodRange(periodDays);
        const res = await fetch(
          `/api/channels/${encodeURIComponent(channel.channelId)}/videos/${encodeURIComponent(selectedVideoId)}/analytics/retention?startDate=${startDate}&endDate=${endDate}`
        );
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setRetentionError(data.message ?? "Failed to load retention data");
          return;
        }
        setRetentionPoints(data.points as RetentionPoint[]);
      } catch {
        if (!cancelled) setRetentionError("Failed to load retention data");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel, selectedVideoId, periodDays]);

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
        <h3 className="text-sm font-medium text-zinc-300">Content</h3>
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

      <AnalyticsBreakdownCard
        channelId={channel.channelId}
        periodDays={periodDays}
        breakdown="trafficSources"
        title="How viewers find your videos"
        metricName="views"
        labelFor={labelTrafficSource}
        formatValue={(v) => `${v.toLocaleString()} views`}
      />

      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h4 className="mb-3 text-sm font-medium text-zinc-300">Top videos</h4>
        {loadingTopVideos && topVideos.length === 0 ? (
          <p className="text-sm text-zinc-500">Loading...</p>
        ) : topVideos.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No collected data for this period yet — use &ldquo;Collect now&rdquo; in the Overview tab to fetch it.
          </p>
        ) : (
          <ul className="space-y-2">
            {topVideos.map((item) => (
              <li key={item.videoId}>
                <button
                  type="button"
                  onClick={() => setSelectedVideoId(item.videoId)}
                  className={`flex w-full items-center gap-3 rounded-lg p-1.5 text-left text-sm transition-colors ${
                    selectedVideoId === item.videoId ? "bg-zinc-800 ring-1 ring-inset ring-indigo-500/60" : "hover:bg-zinc-800/60"
                  }`}
                >
                  {item.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.thumbnail} alt="" className="h-9 w-16 rounded object-cover" />
                  ) : (
                    <div className="h-9 w-16 rounded bg-zinc-800" />
                  )}
                  <span className="flex-1 truncate text-zinc-300">{item.title}</span>
                  <span className="text-zinc-400">{item.views.toLocaleString()} views</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selectedVideoId && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h4 className="mb-1 text-sm font-medium text-zinc-300">Audience retention</h4>
          <p className="mb-3 text-xs text-zinc-500">
            {topVideos.find((v) => v.videoId === selectedVideoId)?.title ?? selectedVideoId}
          </p>
          {retentionError ? (
            <p className="text-sm text-red-400">{retentionError}</p>
          ) : retentionPoints === null ? (
            <p className="text-sm text-zinc-500">Loading...</p>
          ) : retentionPoints.length === 0 ? (
            <p className="text-sm text-zinc-500">No retention data for this video/period yet.</p>
          ) : (
            <AnalyticsLineChart
              data={retentionPoints.map((p) => ({
                date: `${Math.round(p.elapsedVideoTimeRatio * 100)}%`,
                value: Math.round(p.audienceWatchRatio * 100),
              }))}
              formatValue={(v) => `${v}% watching`}
            />
          )}
        </div>
      )}
    </div>
  );
}
