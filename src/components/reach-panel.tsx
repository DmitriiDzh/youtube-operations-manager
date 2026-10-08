"use client";

import { errorText } from "@/lib/ui-text";
import { useCallback, useEffect, useRef, useState } from "react";
import { OperationOverlay, useOperation, LoadingIndicator } from "./operation-progress";
import { computeDefaultPeriodRange, formatChartDate } from "@/lib/analytics/period";
import { formatCtr, formatImpressions } from "@/lib/reach-reports/reach-format";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { AnalyticsLineChart } from "./analytics-line-chart";
import { ReachStatusBlock, type ReachStatusData } from "./reach-status-block";
import { useVideoTitles } from "./use-video-titles";
import { useUiText } from "./ui-text-provider";

type ReachState = "no_job" | "waiting_for_first_report" | "ready";

type ReachData = {
  state: ReachState;
  jobCreatedAt: string | null;
  coverage: { firstDate: string | null; lastDate: string | null; importedFiles: number };
  daily: Array<{ date: string; impressions: number; ctr: number | null }>;
  videos: Array<{ videoId: string; impressions: number; ctr: number | null }>;
  totals: { impressions: number; ctr: number | null };
  /** Only on a `groupBy=video_day` read: the stored rows, one per video per day. */
  videoDaily?: Array<{ videoId: string; date: string; impressions: number; ctr: number | null }>;
  videoDailyTruncated?: boolean;
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
  const { t, formatNumber, language } = useUiText();
  const formatCtrPercent = (v: number) => t("chart.value.ctrShort", { value: formatNumber(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) });
  const op = useOperation();
  const { runBlocking } = op;
  const [data, setData] = useState<ReachData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<ReachStatusData | null>(null);
  const activeChannelRef = useRef(channelId);
  const titles = useVideoTitles(channelId);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  // The loaded detail is tagged with the video/period it was read for and shown only while that is still selected.
  const [detailState, setDetailState] = useState<{ key: string; data: ReachData | null } | null>(null);
  const detailKey = `${channelId}:${selectedVideoId}:${periodDays}`;
  const videoDetail = detailState && detailState.key === detailKey ? detailState.data : null;
  const videoDetailError = detailState?.key === detailKey && detailState.data === null;

  // Per-video drill-down (BL-120): this video's impressions and CTR day by day, from the stored rows -- one request, not one per day.
  useEffect(() => {
    if (!selectedVideoId) return;
    let cancelled = false;
    (async () => {
      try {
        const { startDate, endDate } = computeDefaultPeriodRange(periodDays);
        const res = await fetch(
          `/api/channels/${encodeURIComponent(channelId)}/reach?startDate=${startDate}&endDate=${endDate}&videoId=${encodeURIComponent(selectedVideoId)}&groupBy=video_day`
        );
        const body = res.ok ? ((await res.json()) as ReachData) : null;
        if (!cancelled) setDetailState({ key: `${channelId}:${selectedVideoId}:${periodDays}`, data: body });
      } catch {
        if (!cancelled) setDetailState({ key: `${channelId}:${selectedVideoId}:${periodDays}`, data: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId, periodDays, selectedVideoId]);

  function selectVideo(videoId: string | null) {
    // Clicking the already-open row collapses it again.
    setSelectedVideoId((current) => (videoId !== null && current === videoId ? null : videoId));
  }

  const load = useCallback(async () => {
    try {
      const { startDate, endDate } = computeDefaultPeriodRange(periodDays);
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/reach?startDate=${startDate}&endDate=${endDate}`
      );
      const body = await res.json();
      if (!res.ok) {
        setError(errorText(t, body, t("reach.loadFailed"), { showErrorField: false }));
        return;
      }
      setError(null);
      setData(body as ReachData);
    } catch {
      setError(t("reach.loadFailed"));
    }
  }, [channelId, periodDays, t]);

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
        title: t("reach.syncTitle"),
        stage: t("reach.syncStage"),
        request: async () => {
          const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/reach/sync`, { method: "POST" });
          return { res, body: (await res.json()) as SyncOutcome & { message?: string } };
        },
        failureOf: ({ res, body }) => (res.ok ? null : (errorText(t, body, t("reach.syncFailed"), { showErrorField: false }))),
        summarize: ({ body }) => (body.skipped ? t("reach.nothingNew") : t("reach.filesImported", { count: body.filesImported })),
      });
      if (!res.ok) {
        setError(errorText(t, body, t("reach.syncFailed"), { showErrorField: false }));
        await loadStatus(); // a failed sync is recorded; show it
        return;
      }
      if (!body.skipped) {
        const parts = [
          body.jobCreated ? t("reach.jobCreated") : null,
          t("reach.filesImported", { count: body.filesImported }),
          body.failures.length > 0 ? t("reach.filesFailed", { count: body.failures.length }) : null,
        ].filter(Boolean);
        setNotice(parts.join(" "));
      }
      await Promise.all([load(), loadStatus()]);
    } catch {
      setError(t("reach.syncFailed"));
      await loadStatus();
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <OperationOverlay state={op.state} onClose={op.reset} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-zinc-300">{t("reach.title")}</h4>
        <button
          onClick={syncNow}
          disabled={syncing}
          className="rounded-md border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {syncing ? t("common.syncing") : t("common.syncNow")}
        </button>
      </div>

      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      {notice && <p className="mb-2 text-xs text-emerald-400">{notice}</p>}

      {!data ? (
        !error && <LoadingIndicator className="text-sm text-zinc-500" />
      ) : data.state === "no_job" ? (
        <p className="text-sm text-zinc-500">{t("reach.notSetUp")}</p>
      ) : data.state === "waiting_for_first_report" ? (
        <p className="text-sm text-zinc-500">
          {data.jobCreatedAt ? t("reach.waitingSince", { date: formatDisplayDateTime(data.jobCreatedAt) }) : t("reach.waiting")}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-6 text-sm">
            <div>
              <div className="text-xs text-zinc-500">{t("reach.impressions")}</div>
              <div className="text-lg font-semibold text-zinc-100">{formatImpressions(data.totals.impressions, language)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">{t("reach.ctr")}</div>
              <div className="text-lg font-semibold text-zinc-100">{formatCtr(data.totals.ctr, language)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">{t("reach.dataAvailable")}</div>
              <div className="text-sm text-zinc-300">
                {data.coverage.firstDate} &ndash; {data.coverage.lastDate}
              </div>
            </div>
          </div>

          {data.daily.length === 0 ? (
            <p className="text-sm text-zinc-500">{t("reach.noDailyData")}</p>
          ) : (
            <>
              <AnalyticsLineChart
                data={data.daily.map((d) => ({ date: d.date, value: d.impressions }))}
                formatValue={(v) => t("chart.value.impressions", { count: v })}
                formatDate={(d) => formatChartDate(d, language)}
              />
              {data.daily.some((d) => d.ctr !== null) && (
                <>
                  <div className="text-xs text-zinc-500">{t("reach.ctrByDay")}</div>
                  <AnalyticsLineChart
                    data={data.daily.filter((d) => d.ctr !== null).map((d) => ({ date: d.date, value: (d.ctr as number) * 100 }))}
                    formatValue={formatCtrPercent}
                    formatDate={(d) => formatChartDate(d, language)}
                    colorClassName="text-emerald-400"
                    height={120}
                  />
                </>
              )}
            </>
          )}

          {data.videos.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="py-1 font-medium">{t("reach.column.video")}</th>
                  <th className="py-1 text-right font-medium">{t("reach.impressions")}</th>
                  <th className="py-1 text-right font-medium">{t("reach.ctrShort")}</th>
                </tr>
              </thead>
              <tbody>
                {data.videos.slice(0, 10).map((video) => (
                  <tr
                    key={video.videoId}
                    onClick={() => selectVideo(video.videoId)}
                    className={`cursor-pointer border-t border-zinc-800 text-zinc-300 hover:bg-zinc-800/40 ${
                      selectedVideoId === video.videoId ? "bg-zinc-800/60" : ""
                    }`}
                  >
                    <td className="max-w-[26rem] truncate py-1.5" title={titles.get(video.videoId)?.title ?? video.videoId}>
                      {titles.get(video.videoId)?.title ?? <span className="font-mono text-xs">{video.videoId}</span>}
                    </td>
                    <td className="py-1 text-right">{formatImpressions(video.impressions, language)}</td>
                    <td className="py-1 text-right">{formatCtr(video.ctr, language)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.videos.length > 0 && !selectedVideoId && <p className="text-xs text-zinc-500">{t("reach.clickHint")}</p>}

          {selectedVideoId && (
            <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 truncate text-sm font-medium text-zinc-200">{titles.get(selectedVideoId)?.title ?? selectedVideoId}</div>
                <button onClick={() => selectVideo(null)} className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200">
                  {t("common.close")}
                </button>
              </div>
              {videoDetailError ? (
                <p className="text-sm text-red-400">{t("reach.videoLoadFailed")}</p>
              ) : !videoDetail ? (
                <LoadingIndicator className="text-sm text-zinc-500" />
              ) : !videoDetail.videoDaily || videoDetail.videoDaily.length === 0 ? (
                <p className="text-sm text-zinc-500">{t("reach.videoNoData")}</p>
              ) : (
                <>
                  <div className="text-xs text-zinc-500">
                    {t("reach.videoSummary", { impressions: formatImpressions(videoDetail.totals.impressions, language), ctr: formatCtr(videoDetail.totals.ctr, language) })}
                  </div>
                  <AnalyticsLineChart
                    data={videoDetail.videoDaily.map((d) => ({ date: d.date, value: d.impressions }))}
                    formatValue={(v) => t("chart.value.impressions", { count: v })}
                    formatDate={(d) => formatChartDate(d, language)}
                    height={140}
                  />
                  {videoDetail.videoDaily.some((d) => d.ctr !== null) && (
                    <AnalyticsLineChart
                      data={videoDetail.videoDaily.filter((d) => d.ctr !== null).map((d) => ({ date: d.date, value: (d.ctr as number) * 100 }))}
                      formatValue={formatCtrPercent}
                      formatDate={(d) => formatChartDate(d, language)}
                      colorClassName="text-emerald-400"
                      height={110}
                    />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
      {status && <ReachStatusBlock status={status} />}
    </div>
  );
}
