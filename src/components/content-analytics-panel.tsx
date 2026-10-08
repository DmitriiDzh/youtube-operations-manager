"use client";

import { useEffect, useState } from "react";
import { computeDefaultPeriodRange } from "@/lib/analytics/period";
import { AnalyticsBreakdownCard } from "./analytics-breakdown-card";
import { AnalyticsLineChart } from "./analytics-line-chart";
import { labelTrafficSource } from "@/lib/analytics/breakdown-labels";
import { useTopVideos } from "./use-top-videos";
import { ReachPanel } from "./reach-panel";
import { LoadingIndicator } from "./operation-progress";
import { useUiText } from "./ui-text-provider";

type SyncedChannel = { channelId: string; title: string };
type RetentionPoint = { elapsedVideoTimeRatio: number; audienceWatchRatio: number; relativeRetentionPerformance: number };

const PERIOD_OPTIONS = [
  { days: 7, labelKey: "analytics.period.last7" },
  { days: 28, labelKey: "analytics.period.last28" },
  { days: 90, labelKey: "analytics.period.last90" },
  { days: 365, labelKey: "analytics.period.last365" },
] as const;

/**
 * Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §3.4) --
 * Analytics -> Content sub-tab. Starts with Slice C2 (traffic sources); C4 (retention curve) and
 * C5 (top videos) are follow-up additions to this same panel, not a redesign of it.
 */
export function ContentAnalyticsPanel() {
  const { t, formatNumber } = useUiText();
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
          setRetentionError(data.message ?? t("contentAnalytics.retentionLoadFailed"));
          return;
        }
        setRetentionPoints(data.points as RetentionPoint[]);
      } catch {
        if (!cancelled) setRetentionError(t("contentAnalytics.retentionLoadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel, selectedVideoId, periodDays, t]);

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
    return <LoadingIndicator className="text-sm text-zinc-400" />;
  }

  if (!channel) {
    return (
      <p className="text-sm text-zinc-400">{t("analytics.noChannel")}</p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-zinc-300">{t("tabs.analytics.content")}</h3>
        <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
          {PERIOD_OPTIONS.map((option) => (
            <button
              key={option.days}
              onClick={() => setPeriodDays(option.days)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                periodDays === option.days ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <ReachPanel channelId={channel.channelId} periodDays={periodDays} />

      <AnalyticsBreakdownCard
        channelId={channel.channelId}
        periodDays={periodDays}
        breakdown="trafficSources"
        title={t("contentAnalytics.trafficSources")}
        metricName="views"
        labelFor={labelTrafficSource}
        formatValue={(v) => t("chart.value.views", { count: v })}
      />

      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h4 className="mb-3 text-sm font-medium text-zinc-300">{t("contentAnalytics.topVideos")}</h4>
        {loadingTopVideos && topVideos.length === 0 ? (
          <LoadingIndicator className="text-sm text-zinc-500" />
        ) : topVideos.length === 0 ? (
          <p className="text-sm text-zinc-500">{t("contentAnalytics.noTopVideos")}</p>
        ) : (
          <ul className="space-y-2">
            {topVideos.map((item) => (
              <li key={item.videoId}>
                <button
                  type="button"
                  onClick={() => setSelectedVideoId((current) => (current === item.videoId ? null : item.videoId))}
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
                  <span className="text-zinc-400">{t("chart.value.views", { count: item.views })}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selectedVideoId && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h4 className="mb-1 text-sm font-medium text-zinc-300">{t("contentAnalytics.retention")}</h4>
          <p className="mb-3 text-xs text-zinc-500">
            {topVideos.find((v) => v.videoId === selectedVideoId)?.title ?? selectedVideoId}
          </p>
          {retentionError ? (
            <p className="text-sm text-red-400">{retentionError}</p>
          ) : retentionPoints === null ? (
            <LoadingIndicator className="text-sm text-zinc-500" />
          ) : retentionPoints.length === 0 ? (
            <p className="text-sm text-zinc-500">{t("contentAnalytics.noRetention")}</p>
          ) : (
            <AnalyticsLineChart
              data={retentionPoints.map((p) => ({
                date: t("analytics.percent", { value: Math.round(p.elapsedVideoTimeRatio * 100) }),
                value: Math.round(p.audienceWatchRatio * 100),
              }))}
              formatValue={(v) => t("chart.value.watching", { value: formatNumber(v) })}
            />
          )}
        </div>
      )}
    </div>
  );
}
