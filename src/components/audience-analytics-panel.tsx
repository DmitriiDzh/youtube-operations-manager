"use client";

import { useEffect, useState } from "react";
import { AnalyticsBreakdownCard } from "./analytics-breakdown-card";
import {
  labelAgeGender,
  labelContentFormat,
  labelCountry,
  labelDeviceType,
  labelSubscribedStatus,
} from "@/lib/analytics/breakdown-labels";

type SyncedChannel = { channelId: string; title: string };

const PERIOD_OPTIONS = [
  { days: 7, label: "Last 7 days" },
  { days: 28, label: "Last 28 days" },
  { days: 90, label: "Last 90 days" },
  { days: 365, label: "Last 365 days" },
] as const;

const formatHours = (v: number) => `${(v / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })} hours`;

/**
 * Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §4.4) --
 * Analytics -> Audience sub-tab. Slices A2 (device type), A3 (age/gender + geography), A4
 * (subscribed status), A6 (content format) -- all confirmed-feasible against real data (BL-094).
 * A5 (new/casual/regular) and A7-deferred (heatmap, cross-channel affinity) are intentionally not
 * here yet -- each still has an open feasibility question the plan's own §4.3/§4.4 leaves
 * unresolved, not a UI gap.
 */
export function AudienceAnalyticsPanel() {
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
        <h3 className="text-sm font-medium text-zinc-300">Audience</h3>
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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <AnalyticsBreakdownCard
          channelId={channel.channelId}
          periodDays={periodDays}
          breakdown="deviceType"
          title="Device type"
          metricName="estimatedMinutesWatched"
          labelFor={labelDeviceType}
          formatValue={formatHours}
        />
        <AnalyticsBreakdownCard
          channelId={channel.channelId}
          periodDays={periodDays}
          breakdown="geography"
          title="Top geographies"
          metricName="views"
          labelFor={labelCountry}
          formatValue={(v) => `${v.toLocaleString()} views`}
        />
        <AnalyticsBreakdownCard
          channelId={channel.channelId}
          periodDays={periodDays}
          breakdown="ageGender"
          title="Age and gender"
          metricName="viewerPercentage"
          labelFor={labelAgeGender}
          formatValue={(v) => `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}
          // Live-observed against the real "Rural Japan Music" channel (docs/roadmap/plans/
          // ANALYTICS_TAB_DEEP_PARITY_PLAN.md §4.2) -- Studio's own exact wording for this specific
          // empty state, not a guess.
          emptyMessage="Not enough demographic data to show this report"
        />
        <AnalyticsBreakdownCard
          channelId={channel.channelId}
          periodDays={periodDays}
          breakdown="subscribedStatus"
          title="Watch time from subscribers"
          metricName="estimatedMinutesWatched"
          labelFor={labelSubscribedStatus}
          formatValue={formatHours}
        />
        <AnalyticsBreakdownCard
          channelId={channel.channelId}
          periodDays={periodDays}
          breakdown="contentFormat"
          title="Formats your viewers watch"
          metricName="estimatedMinutesWatched"
          labelFor={labelContentFormat}
          formatValue={formatHours}
        />
      </div>
    </div>
  );
}
