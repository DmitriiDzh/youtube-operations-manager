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
import { LoadingIndicator } from "./operation-progress";
import { useUiText } from "./ui-text-provider";

type SyncedChannel = { channelId: string; title: string };

const PERIOD_OPTIONS = [
  { days: 7, labelKey: "analytics.period.last7" },
  { days: 28, labelKey: "analytics.period.last28" },
  { days: 90, labelKey: "analytics.period.last90" },
  { days: 365, labelKey: "analytics.period.last365" },
] as const;

/**
 * Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §4.4) --
 * Analytics -> Audience sub-tab. Slices A2 (device type), A3 (age/gender + geography), A4
 * (subscribed status), A6 (content format) -- all confirmed-feasible against real data (BL-094).
 * A5 (new/casual/regular) and A7-deferred (heatmap, cross-channel affinity) are intentionally not
 * here yet -- each still has an open feasibility question the plan's own §4.3/§4.4 leaves
 * unresolved, not a UI gap.
 */
export function AudienceAnalyticsPanel() {
  const { t, formatNumber } = useUiText();
  const formatHours = (v: number) => t("chart.value.hours", { value: formatNumber(v / 60, { maximumFractionDigits: 1 }) });
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
        <h3 className="text-sm font-medium text-zinc-300">{t("tabs.analytics.audience")}</h3>
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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <AnalyticsBreakdownCard
          channelId={channel.channelId}
          periodDays={periodDays}
          breakdown="deviceType"
          title={t("audience.deviceType")}
          metricName="estimatedMinutesWatched"
          labelFor={labelDeviceType}
          formatValue={formatHours}
        />
        <AnalyticsBreakdownCard
          channelId={channel.channelId}
          periodDays={periodDays}
          breakdown="geography"
          title={t("audience.geography")}
          metricName="views"
          labelFor={labelCountry}
          formatValue={(v) => t("chart.value.views", { count: v })}
        />
        <AnalyticsBreakdownCard
          channelId={channel.channelId}
          periodDays={periodDays}
          breakdown="ageGender"
          title={t("audience.ageGender")}
          metricName="viewerPercentage"
          labelFor={labelAgeGender}
          formatValue={(v) => t("analytics.percent", { value: formatNumber(v, { maximumFractionDigits: 1 }) })}
          // Live-observed against the real "Rural Japan Music" channel (docs/roadmap/plans/
          // ANALYTICS_TAB_DEEP_PARITY_PLAN.md §4.2) -- Studio's own exact wording for this specific
          // empty state, not a guess.
          emptyMessage={t("audience.ageGenderEmpty")}
        />
        <AnalyticsBreakdownCard
          channelId={channel.channelId}
          periodDays={periodDays}
          breakdown="subscribedStatus"
          title={t("audience.subscribedStatus")}
          metricName="estimatedMinutesWatched"
          labelFor={labelSubscribedStatus}
          formatValue={formatHours}
        />
        <AnalyticsBreakdownCard
          channelId={channel.channelId}
          periodDays={periodDays}
          breakdown="contentFormat"
          title={t("audience.contentFormat")}
          metricName="estimatedMinutesWatched"
          labelFor={labelContentFormat}
          formatValue={formatHours}
        />
      </div>
    </div>
  );
}
