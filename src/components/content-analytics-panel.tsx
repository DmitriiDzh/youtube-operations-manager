"use client";

import { useEffect, useState } from "react";
import { AnalyticsBreakdownCard } from "./analytics-breakdown-card";
import { labelTrafficSource } from "@/lib/analytics/breakdown-labels";

type SyncedChannel = { channelId: string; title: string };

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
    </div>
  );
}
