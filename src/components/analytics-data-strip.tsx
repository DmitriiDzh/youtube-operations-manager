"use client";

import { useEffect, useState } from "react";
import { formatDisplayDateTime, formatDisplayDateUtc } from "@/lib/shared-formatting";
import { useT } from "./ui-text-provider";

export type StripOverviewInfo = {
  source?: "live" | "local";
  collectedAt?: string | null;
  channelStartDate: string | null;
  provisionalFromDate: string;
  endDate: string;
};

export type StripDataQuality = {
  notApplicableRange?: { startDate: string; endDate: string } | null;
  uncoveredRanges?: Array<{ startDate: string; endDate: string }>;
  uncoveredDates: string[];
  videosWithSkips: Array<{ videoId: string }>;
};

type HistoryStatus = { remainingVideos: number; hasChannelGap: boolean };

const range = (r: { startDate: string; endDate: string }) =>
  r.startDate === r.endDate ? formatDisplayDateUtc(r.startDate) : `${formatDisplayDateUtc(r.startDate)} – ${formatDisplayDateUtc(r.endDate)}`;

/**
 * BL-120 -- one compact block that says where the Overview numbers came from and how complete they are: stored vs live (and when it was
 * collected), the channel's start date, days before it (not applicable -- never a gap), days still to be collected, the preliminary last days,
 * and whether the automatic history catch-up is still filling earlier days. Everything here is already stored data or arithmetic on it.
 */
export function AnalyticsDataStrip({
  channelId,
  overview,
  dataQuality,
  refreshing,
  onRefreshLive,
  reloadKey,
}: {
  channelId: string;
  overview: StripOverviewInfo;
  dataQuality: StripDataQuality | null;
  refreshing: boolean;
  onRefreshLive: () => void;
  /** Changes whenever new data was collected, so the catch-up status is read again. */
  reloadKey: number;
}) {
  const t = useT();
  const [history, setHistory] = useState<HistoryStatus | null>(null);
  const [backfillRunning, setBackfillRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [historyRes, operationsRes] = await Promise.all([
          fetch(`/api/channels/${encodeURIComponent(channelId)}/analytics/history-status`),
          fetch(`/api/operations?channelId=${encodeURIComponent(channelId)}&kind=analytics-backfill&active=1`),
        ]);
        if (cancelled) return;
        if (historyRes.ok) setHistory((await historyRes.json()) as HistoryStatus);
        if (operationsRes.ok) {
          const body = (await operationsRes.json()) as { operations?: unknown[] };
          setBackfillRunning((body.operations?.length ?? 0) > 0);
        }
      } catch {
        // Secondary information: the strip simply omits the history line.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId, reloadKey]);

  const uncovered = dataQuality?.uncoveredRanges ?? [];
  const filling = history !== null && (history.remainingVideos > 0 || history.hasChannelGap);

  return (
    <div className="space-y-1.5 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-xs text-zinc-400">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          {overview.source === "local" ? (
            <>
              <span className="font-medium text-zinc-200">{t("analytics.strip.stored")}</span>
              {overview.collectedAt ? <> · {t("analytics.strip.collectedAt", { date: formatDisplayDateTime(overview.collectedAt) })}</> : null}
            </>
          ) : (
            <>
              <span className="font-medium text-zinc-200">{t("analytics.strip.live")}</span> · {t("analytics.strip.readJustNow")}
            </>
          )}
        </p>
        {overview.source === "local" && (
          <button
            onClick={onRefreshLive}
            disabled={refreshing}
            className="rounded-md border border-zinc-700 px-3 py-1 font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {refreshing ? t("analytics.strip.refreshing") : t("analytics.strip.refreshLive")}
          </button>
        )}
      </div>

      {overview.channelStartDate && (
        <p>
          {t("analytics.strip.channelCreated", { date: formatDisplayDateUtc(overview.channelStartDate) })}
          {dataQuality?.notApplicableRange ? <> · {t("analytics.strip.notApplicable", { range: range(dataQuality.notApplicableRange) })}</> : null}
        </p>
      )}

      <p>
        {uncovered.length === 0 && (dataQuality?.uncoveredDates.length ?? 0) === 0
          ? t("analytics.strip.allCollected")
          : uncovered.length > 0
            ? t("analytics.strip.notCollectedRanges", { ranges: uncovered.map(range).join(", ") })
            : t("analytics.strip.notCollectedDays", { count: dataQuality?.uncoveredDates.length ?? 0 })}{" "}
        {t("analytics.strip.provisional", { date: formatDisplayDateUtc(overview.provisionalFromDate) })}
      </p>

      {history && (
        <p>
          {filling
            ? t(history.hasChannelGap ? "analytics.strip.historyFillingWithChannel" : "analytics.strip.historyFilling", {
                count: history.remainingVideos,
                state: t(backfillRunning ? "analytics.strip.historyRunning" : "analytics.strip.historyContinues"),
              })
            : t("analytics.strip.historyComplete")}
        </p>
      )}

      {(dataQuality?.videosWithSkips.length ?? 0) > 0 && (
        <p className="text-amber-300">
          {t("analytics.strip.skips", { count: dataQuality?.videosWithSkips.length ?? 0 })}
        </p>
      )}
    </div>
  );
}
