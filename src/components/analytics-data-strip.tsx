"use client";

import { useEffect, useState } from "react";
import { formatDisplayDateTime, formatDisplayDateUtc } from "@/lib/shared-formatting";

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
              <span className="font-medium text-zinc-200">Stored data</span>
              {overview.collectedAt ? <> · collected {formatDisplayDateTime(overview.collectedAt)}</> : null}
            </>
          ) : (
            <>
              <span className="font-medium text-zinc-200">Live from YouTube</span> · read just now
            </>
          )}
        </p>
        {overview.source === "local" && (
          <button
            onClick={onRefreshLive}
            disabled={refreshing}
            className="rounded-md border border-zinc-700 px-3 py-1 font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {refreshing ? "Refreshing..." : "Refresh live"}
          </button>
        )}
      </div>

      {overview.channelStartDate && (
        <p>
          Channel created {formatDisplayDateUtc(overview.channelStartDate)}
          {dataQuality?.notApplicableRange ? <> · {range(dataQuality.notApplicableRange)} is before the channel existed (not applicable)</> : null}
        </p>
      )}

      <p>
        {uncovered.length === 0 && (dataQuality?.uncoveredDates.length ?? 0) === 0
          ? "Every day of this period is collected."
          : uncovered.length > 0
            ? `Not collected yet: ${uncovered.map(range).join(", ")}.`
            : `${dataQuality?.uncoveredDates.length} day(s) of this period are not collected yet.`}{" "}
        The latest days (from {formatDisplayDateUtc(overview.provisionalFromDate)}) are preliminary: YouTube keeps adjusting them and they are
        refreshed automatically.
      </p>

      {history && (
        <p>
          {filling
            ? `Filling earlier history: ${history.remainingVideos} video${history.remainingVideos === 1 ? "" : "s"} left${
                history.hasChannelGap ? " and the channel totals" : ""
              } — ${backfillRunning ? "running now" : "continues automatically"}.`
            : "Earlier history is complete."}
        </p>
      )}

      {(dataQuality?.videosWithSkips.length ?? 0) > 0 && (
        <p className="text-amber-300">
          {dataQuality?.videosWithSkips.length} video{dataQuality?.videosWithSkips.length === 1 ? "" : "s"} had a collection failure in the most
          recent collection run covering this period.
        </p>
      )}
    </div>
  );
}
