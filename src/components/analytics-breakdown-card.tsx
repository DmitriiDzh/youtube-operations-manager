"use client";

import { useEffect, useState } from "react";
import { computeDefaultPeriodRange } from "@/lib/analytics/period";

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
  formatValue = (v) => v.toLocaleString(),
}: {
  channelId: string;
  periodDays: number;
  breakdown: string;
  title: string;
  metricName: string;
  labelFor: (dimensionValues: string[]) => string;
  formatValue?: (value: number) => string;
}) {
  const [rows, setRows] = useState<BreakdownRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    (async () => {
      try {
        const { startDate, endDate } = computeDefaultPeriodRange(periodDays);
        const res = await fetch(
          `/api/channels/${encodeURIComponent(channelId)}/analytics/breakdown?startDate=${startDate}&endDate=${endDate}&breakdown=${breakdown}`
        );
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.message ?? "Failed to load");
          return;
        }
        setRows(data.rows as BreakdownRow[]);
      } catch {
        if (!cancelled) setError("Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId, periodDays, breakdown]);

  const ranked = (rows ?? [])
    .map((row) => ({ label: labelFor(row.dimensionValues), value: row.metrics[metricName] ?? 0 }))
    .sort((a, b) => b.value - a.value);
  const total = ranked.reduce((sum, row) => sum + row.value, 0);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h4 className="mb-3 text-sm font-medium text-zinc-300">{title}</h4>
      {error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : rows === null ? (
        <p className="text-sm text-zinc-500">Loading...</p>
      ) : ranked.length === 0 ? (
        <p className="text-sm text-zinc-500">No data for this period yet.</p>
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
