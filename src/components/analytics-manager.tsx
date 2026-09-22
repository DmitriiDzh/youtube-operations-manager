"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type SyncedChannel = {
  channelId: string;
  title: string;
};

type MetricRow = {
  videoId: string;
  metricDate: string;
  metricName: string;
  metricValue: number;
};

type CollectResult = {
  videoCount: number;
  upsertsIssued: number;
  skippedVideoIds: string[];
};

const PAGE_SIZE = 30;

// Local calendar date, deliberately NOT toISOString() (which is UTC and can land on the wrong
// day depending on the operator's timezone/time of day). This is just the default value for the
// date-range *inputs* -- unrelated to `metric_date` values the API returns, which are always a
// Pacific-Time reporting day regardless of what range was requested here
// (docs/roadmap/plans/PHASE_8_PLAN.md §10 item 4).
function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultDateRange(): { startDate: string; endDate: string } {
  // Ends yesterday, not today: the API's own documented behavior is that a `day`-dimension query
  // never returns rows for the most recent day(s) yet, so defaulting to "today" would make a
  // fresh collection look like it silently returned less than requested.
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  return { startDate: formatLocalDate(start), endDate: formatLocalDate(end) };
}

function formatMetricValue(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
}

/**
 * The "Analytics" tab (Phase 8, BL-058, docs/roadmap/plans/PHASE_8_PLAN.md §6 slice 4) --
 * replaces the earlier "coming soon" placeholder (Studio-parity S6-stub, BL-017) now that the
 * OAuth scope (BL-056) and the collection adapter (BL-057) exist. Deliberately minimal: a manual
 * "Collect now" trigger and a read-only table of whatever has been collected so far -- no
 * scheduling UI yet (BL-059, separate), no reports/comparisons (Phase 10's own scope per
 * `docs/roadmap/FUTURE_PHASES.md` §4's "facts only" constraint).
 */
export function AnalyticsManager() {
  const [channel, setChannel] = useState<SyncedChannel | null>(null);
  const [loadingChannel, setLoadingChannel] = useState(true);
  const [rows, setRows] = useState<MetricRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error` -- "already up to date" (owner instruction, 2026-09-22's daily
  // freshness gate) is expected, normal behavior, not a failure, so it gets neutral styling
  // rather than the red error box below.
  const [dataCurrentNotice, setDataCurrentNotice] = useState<string | null>(null);
  const [collectResult, setCollectResult] = useState<CollectResult | null>(null);
  const [page, setPage] = useState(1);

  const [{ startDate, endDate }, setDateRange] = useState(defaultDateRange);

  const fetchRows = useCallback(async (channelId: string) => {
    setLoadingRows(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/analytics`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to load collected metrics");
        return;
      }
      setRows(data.rows as MetricRow[]);
    } catch {
      setError("Failed to load collected metrics");
    } finally {
      setLoadingRows(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingChannel(true);
      try {
        const res = await fetch("/api/channels");
        const data = await res.json();
        if (cancelled || !res.ok || !Array.isArray(data.channels)) return;
        const active = (data.channels as SyncedChannel[])[0];
        if (!active) return;
        setChannel(active);
        await fetchRows(active.channelId);
      } finally {
        if (!cancelled) setLoadingChannel(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only, same reasoning as content-manager.tsx's own channel-resolution effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCollect = useCallback(async () => {
    if (!channel) return;
    setCollecting(true);
    setError(null);
    setDataCurrentNotice(null);
    setCollectResult(null);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channel.channelId)}/analytics/collect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ startDate, endDate }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === "analytics_data_current" && data.details?.nextRefreshAt) {
          setDataCurrentNotice(
            `Analytics data is already up to date for today -- YouTube itself only refreshes it about once a day. Next refresh available at ${new Date(data.details.nextRefreshAt).toLocaleString()}.`
          );
        } else {
          setError(data.message ?? "Collection failed");
        }
        return;
      }
      setCollectResult({
        videoCount: typeof data.videoCount === "number" ? data.videoCount : 0,
        upsertsIssued: typeof data.upsertsIssued === "number" ? data.upsertsIssued : 0,
        skippedVideoIds: Array.isArray(data.skippedVideoIds) ? data.skippedVideoIds : [],
      });
      await fetchRows(channel.channelId);
      setPage(1);
    } catch {
      setError("Collection failed");
    } finally {
      setCollecting(false);
    }
  }, [channel, startDate, endDate, fetchRows]);

  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        if (a.metricDate !== b.metricDate) return b.metricDate.localeCompare(a.metricDate);
        if (a.videoId !== b.videoId) return a.videoId.localeCompare(b.videoId);
        return a.metricName.localeCompare(b.metricName);
      }),
    [rows]
  );

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount);
  const pageStart = (clampedPage - 1) * PAGE_SIZE;
  const pageRows = sortedRows.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {loadingChannel ? (
          <p className="text-sm text-zinc-400">Loading...</p>
        ) : !channel ? (
          <p className="text-sm text-zinc-400">
            No channel synchronized yet — sign in and sync a channel in the Content tab first.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-zinc-400">
                Start date
                <input
                  type="date"
                  value={startDate}
                  max={endDate}
                  onChange={(e) => setDateRange((prev) => ({ ...prev, startDate: e.target.value }))}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-zinc-400">
                End date
                <input
                  type="date"
                  value={endDate}
                  min={startDate}
                  onChange={(e) => setDateRange((prev) => ({ ...prev, endDate: e.target.value }))}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
                />
              </label>
              <button
                onClick={handleCollect}
                disabled={collecting}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {collecting ? "Collecting..." : "Collect now"}
              </button>
            </div>
            <p className="text-xs text-zinc-500">
              Pulls every metric available under the read-only YouTube Analytics scope for each
              synced video, one video at a time. Views/likes/comments and similar counts are
              exact; percentage/rate metrics are shown to two decimal places.
            </p>
          </>
        )}

        {collectResult && (
          <p className="text-sm font-medium text-green-500">
            Collected for {collectResult.videoCount} video{collectResult.videoCount === 1 ? "" : "s"}
            {" — "}
            {collectResult.upsertsIssued} value{collectResult.upsertsIssued === 1 ? "" : "s"} written
            {collectResult.skippedVideoIds.length > 0 &&
              ` (${collectResult.skippedVideoIds.length} video${collectResult.skippedVideoIds.length === 1 ? "" : "s"} skipped due to an error)`}
            .
          </p>
        )}

        {dataCurrentNotice && (
          <div className="rounded-lg border border-zinc-700 bg-zinc-800/60 p-3 text-sm text-zinc-300">
            {dataCurrentNotice}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">
            {error}
          </div>
        )}
      </div>

      {channel && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
            <span className="text-sm text-zinc-400">
              {loadingRows ? "Loading..." : `${sortedRows.length} collected value${sortedRows.length === 1 ? "" : "s"}`}
            </span>
          </div>

          {sortedRows.length === 0 && !loadingRows ? (
            <p className="px-4 py-6 text-sm text-zinc-500">
              Nothing collected yet for this channel — pick a date range above and click
              &ldquo;Collect now&rdquo;.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] table-fixed text-sm">
                <colgroup>
                  <col />
                  <col className="w-28" />
                  <col className="w-48" />
                  <col className="w-24" />
                </colgroup>
                <thead>
                  <tr className="border-b border-zinc-800 text-left text-xs uppercase text-zinc-500">
                    <th className="px-4 py-2 font-medium">Video</th>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Metric</th>
                    <th className="px-4 py-2 text-right font-medium">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => (
                    <tr
                      key={`${row.videoId}|${row.metricDate}|${row.metricName}`}
                      className="border-b border-zinc-800/50 last:border-b-0"
                    >
                      <td className="truncate px-4 py-2 text-zinc-300">{row.videoId}</td>
                      <td className="px-4 py-2 text-zinc-400">{row.metricDate}</td>
                      <td className="px-4 py-2 text-zinc-400">{row.metricName}</td>
                      <td className="px-4 py-2 text-right text-zinc-100">{formatMetricValue(row.metricValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pageCount > 1 && (
            <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3 text-sm">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={clampedPage <= 1}
                className="rounded-lg border border-zinc-700 px-3 py-1 disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-zinc-400">
                Page {clampedPage} of {pageCount}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                disabled={clampedPage >= pageCount}
                className="rounded-lg border border-zinc-700 px-3 py-1 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
