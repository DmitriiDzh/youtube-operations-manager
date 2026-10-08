"use client";

import { errorText, type Translate } from "@/lib/ui-text";
import { useEffect, useState } from "react";
import { computeDefaultPeriodRange } from "@/lib/analytics/period";
import { LoadingIndicator } from "./operation-progress";
import { useUiText } from "./ui-text-provider";

type BreakdownRow = { dimensionValues: string[]; metrics: Record<string, number> };

/**
 * Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §1's
 * cross-cutting note, slices C2/A2/A3/A4/A6) -- one shared ranked-bar-breakdown card, reused by
 * every Content/Audience card that shows "share of total by category" (traffic sources, device
 * type, age/gender, geography, subscribed status, content format). Each caller supplies only
 * which breakdown to fetch, how to label a raw dimension-value row, and which metric to rank by --
 * everything else (fetch, loading/error states, bar rendering) is identical across all of them.
 */
export function AnalyticsBreakdownCard({
  channelId,
  periodDays,
  breakdown,
  title,
  metricName,
  labelFor,
  formatValue: formatValueProp,
  // Independent review round 6 (2026-09-26): the plan's own §1 cross-cutting note requires an
  // empty state matching Studio's own wording/tone per card, not one generic message for every
  // breakdown kind -- Studio's real, live-observed message for age/gender specifically
  // ("Not enough demographic data to show this report") is genuinely different in tone from a
  // plain "no data yet." Callers with a known Studio wording pass it here; others keep the
  // generic default rather than a guessed-at Studio phrase this session never actually observed.
  emptyMessage: emptyMessageProp,
}: {
  channelId: string;
  periodDays: number;
  breakdown: string;
  title: string;
  metricName: string;
  /** BL-152: gets the interface-language translator, so dimension values are labelled in that language. */
  labelFor: (dimensionValues: string[], t: Translate) => string;
  formatValue?: (value: number) => string;
  emptyMessage?: string;
}) {
  const { t, formatNumber } = useUiText();
  const formatValue = formatValueProp ?? ((v: number) => formatNumber(v));
  const emptyMessage = emptyMessageProp ?? t("chart.noData");
  const [rows, setRows] = useState<BreakdownRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Runs synchronously up to the first await, exactly like a reset before the call (react-hooks/set-state-in-effect).
      setRows(null);
      setError(null);
      try {
        const { startDate, endDate } = computeDefaultPeriodRange(periodDays);
        const res = await fetch(
          `/api/channels/${encodeURIComponent(channelId)}/analytics/breakdown?startDate=${startDate}&endDate=${endDate}&breakdown=${breakdown}`
        );
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(errorText(t, data, t("analytics.breakdown.loadFailed"), { showErrorField: false }));
          return;
        }
        setRows(data.rows as BreakdownRow[]);
      } catch {
        if (!cancelled) setError(t("analytics.breakdown.loadFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId, periodDays, breakdown, t]);

  const ranked = (rows ?? [])
    .map((row) => ({ label: labelFor(row.dimensionValues, t), value: row.metrics[metricName] ?? 0 }))
    .sort((a, b) => b.value - a.value);
  const total = ranked.reduce((sum, row) => sum + row.value, 0);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h4 className="mb-3 text-sm font-medium text-zinc-300">{title}</h4>
      {error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : rows === null ? (
        <LoadingIndicator className="text-sm text-zinc-500" />
      ) : ranked.length === 0 ? (
        <p className="text-sm text-zinc-500">{emptyMessage}</p>
      ) : (
        <ul className="space-y-2">
          {ranked.map((row) => (
            <li key={row.label} className="flex items-center gap-3 text-sm">
              <span className="w-40 shrink-0 truncate text-zinc-300">{row.label}</span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
                <span
                  className="block h-full rounded-full bg-indigo-500"
                  style={{ width: `${total > 0 ? (row.value / total) * 100 : 0}%` }}
                />
              </span>
              <span className="w-16 shrink-0 text-right text-zinc-400">{formatValue(row.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
