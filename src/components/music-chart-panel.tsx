"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { MUSIC_CHART_REGIONS } from "@/lib/market-intelligence/music-chart-regions";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { useT } from "./ui-text-provider";

type Entry = { rank: number; videoId: string; title: string; channelTitle: string | null; viewCount: number | null };
type Chart = { regionCode: string; fetchedAt: string; entries: Entry[] };

const REGIONS = MUSIC_CHART_REGIONS;

/**
 * Phase 13 slice 13.9 (docs/roadmap/plans/PHASE_13_PLAN.md) -- YouTube's Trending Music chart for one
 * region, as of now (the general Trending page closed in July 2025; Music, Movies and Gaming charts
 * remain). Loaded only when the operator asks, 1 quota unit per region per 30 minutes.
 */
export function MusicChartPanel() {
  const t = useT();
  const [region, setRegion] = useState("US");
  const [chart, setChart] = useState<Chart | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (code: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/market-intelligence/music-chart?region=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? t("common.errorStatus", { status: String(res.status) }));
        return;
      }
      setChart(data as Chart);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    setChart(null);
  }, [region]);

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        {t("musicChart.title")}
        <InfoTooltip>{t("musicChart.info")}</InfoTooltip>
      </h3>
      <div className="flex items-center gap-2">
        <select
          aria-label={t("musicChart.regionLabel")}
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
        >
          {REGIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          disabled={loading}
          onClick={() => void load(region)}
          className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {loading ? t("common.loading") : t("musicChart.show")}
        </button>
        {chart && <span className="text-xs text-zinc-500">{t("musicChart.asOf", { date: formatDisplayDateTime(chart.fetchedAt) })}</span>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {chart && (
        <ol className="space-y-1 text-sm text-zinc-300">
          {chart.entries.map((e) => (
            <li key={e.videoId} className="flex justify-between gap-3">
              <span>
                {e.rank}.{" "}
                <a href={`https://www.youtube.com/watch?v=${e.videoId}`} target="_blank" rel="noreferrer" className="hover:underline">
                  {e.title}
                </a>
                {e.channelTitle && <span className="text-zinc-500"> &middot; {e.channelTitle}</span>}
              </span>
              <span className="shrink-0 text-zinc-500">{e.viewCount === null ? "" : t("musicChart.views", { count: e.viewCount })}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
