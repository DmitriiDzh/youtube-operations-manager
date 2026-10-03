"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { OperationOverlay, useOperation, LoadingIndicator } from "./operation-progress";
import { computeDefaultPeriodRange } from "@/lib/analytics/period";
import { formatCtr, formatImpressions } from "@/lib/reach-reports/reach-format";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { AnalyticsLineChart } from "./analytics-line-chart";
import { ReachStatusBlock, type ReachStatusData } from "./reach-status-block";

type ReachState = "no_job" | "waiting_for_first_report" | "ready";

type ReachData = {
  state: ReachState;
  jobCreatedAt: string | null;
  coverage: { firstDate: string | null; lastDate: string | null; importedFiles: number };
  daily: Array<{ date: string; impressions: number; ctr: number | null }>;
  videos: Array<{ videoId: string; impressions: number; ctr: number | null }>;
  totals: { impressions: number; ctr: number | null };
};

type SyncOutcome =
  | { skipped: true }
  | { skipped: false; jobCreated: boolean; filesImported: number; failures: Array<{ reportId: string; error: string }> };

/**
 * BL-114 (docs/decisions/0014-youtube-reporting-api-gateway-child.md) -- thumbnail impressions and CTR from the
 * YouTube Reporting API's Reach report, on Analytics -> Content. Its own panel and its own endpoints, so the rest
 * of the Analytics tab keeps working when Reporting reads are off or this fails (AGENTS.md §M). An empty result is
 * never shown as zero: the card says whether there is no job, a job still waiting for Google's first file, or data.
 */
export function ReachPanel({ channelId, periodDays }: { channelId: string; periodDays: number }) {
  const op = useOperation();
  const { runBlocking } = op;
  const [data, setData] = useState<ReachData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<ReachStatusData | null>(null);
  const activeChannelRef = useRef(channelId);

  const load = useCallback(async () => {
    try {
      const { startDate, endDate } = computeDefaultPeriodRange(periodDays);
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/reach?startDate=${startDate}&endDate=${endDate}`
      );
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? "Failed to load impressions data");
        return;
      }
      setError(null);
      setData(body as ReachData);
    } catch {
      setError("Failed to load impressions data");
    }
  }, [channelId, periodDays]);

  // The status block is secondary: if it cannot load, the data above still shows.
  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/reach/status`);
      const body = res.ok ? ((await res.json()) as ReachStatusData) : null;
      // Ignore a response that arrives after the user switched channels (this callback is recreated per channel).
      if (body && activeChannelRef.current === channelId) setStatus(body);
    } catch {
      // keep the previous status, if any
    }
  }, [channelId]);

  useEffect(() => {
    // A different channel never shows the previous channel's status, even if the new status request fails.
    activeChannelRef.current = channelId;
    setStatus(null);
    let cancelled = false;
    (async () => {
      if (!cancelled) await Promise.all([load(), loadStatus()]);
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId, load, loadStatus]);

  async function syncNow() {
    setSyncing(true);
    setNotice(null);
    setError(null);
    try {
      const { res, body } = await runBlocking({
        title: "Importing reach reports from YouTube",
        stage: "Downloading the YouTube Reporting API files",
        request: async () => {
          const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/reach/sync`, { method: "POST" });
          return { res, body: (await res.json()) as SyncOutcome & { message?: string } };
        },
        failureOf: ({ res, body }) => (res.ok ? null : (body.message ?? "Sync failed")),
        summarize: ({ body }) => (body.skipped ? "Nothing new to import." : `${body.filesImported} new report file(s) imported.`),
      });
      if (!res.ok) {
        setError(body.message ?? "Sync failed");
        await loadStatus(); // a failed sync is recorded; show it
        return;
      }
      if (!body.skipped) {
        const parts = [
          body.jobCreated ? "Reporting job created." : null,
          `${body.filesImported} new report file(s) imported.`,
          body.failures.length > 0 ? `${body.failures.length} file(s) failed and will be retried.` : null,
        ].filter(Boolean);
        setNotice(parts.join(" "));
      }
      await Promise.all([load(), loadStatus()]);
    } catch {
      setError("Sync failed");
      await loadStatus();
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <OperationOverlay state={op.state} onClose={op.reset} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-zinc-300">Impressions and click-through rate</h4>
        <button
          onClick={syncNow}
          disabled={syncing}
          className="rounded-md border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {syncing ? "Syncing..." : "Sync now"}
        </button>
      </div>

      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      {notice && <p className="mb-2 text-xs text-emerald-400">{notice}</p>}

      {!data ? (
        !error && <LoadingIndicator className="text-sm text-zinc-500" />
      ) : data.state === "no_job" ? (
        <p className="text-sm text-zinc-500">
          Not set up yet. YouTube provides impressions and CTR only as daily report files; &ldquo;Sync now&rdquo; creates
          the report subscription for this channel. The first file arrives within about 48 hours.
        </p>
      ) : data.state === "waiting_for_first_report" ? (
        <p className="text-sm text-zinc-500">
          Waiting for YouTube&rsquo;s first report file
          {data.jobCreatedAt ? ` (subscription created ${formatDisplayDateTime(data.jobCreatedAt)})` : ""}. This is
          not zero impressions &mdash; there is simply no data yet. It can take up to 48 hours.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-6 text-sm">
            <div>
              <div className="text-xs text-zinc-500">Impressions</div>
              <div className="text-lg font-semibold text-zinc-100">{formatImpressions(data.totals.impressions)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Click-through rate</div>
              <div className="text-lg font-semibold text-zinc-100">{formatCtr(data.totals.ctr)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Data available</div>
              <div className="text-sm text-zinc-300">
                {data.coverage.firstDate} &ndash; {data.coverage.lastDate}
              </div>
            </div>
          </div>

          {data.daily.length === 0 ? (
            <p className="text-sm text-zinc-500">No impressions data inside this period yet.</p>
          ) : (
            <AnalyticsLineChart
              data={data.daily.map((d) => ({ date: d.date, value: d.impressions }))}
              formatValue={(v) => `${formatImpressions(v)} impressions`}
            />
          )}

          {data.videos.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="py-1 font-medium">Video</th>
                  <th className="py-1 text-right font-medium">Impressions</th>
                  <th className="py-1 text-right font-medium">CTR</th>
                </tr>
              </thead>
              <tbody>
                {data.videos.slice(0, 10).map((video) => (
                  <tr key={video.videoId} className="border-t border-zinc-800 text-zinc-300">
                    <td className="py-1 font-mono text-xs">{video.videoId}</td>
                    <td className="py-1 text-right">{formatImpressions(video.impressions)}</td>
                    <td className="py-1 text-right">{formatCtr(video.ctr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {status && <ReachStatusBlock status={status} />}
    </div>
  );
}
