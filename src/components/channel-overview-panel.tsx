"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeDefaultPeriodRange, computePercentChange, formatChartDate, formatWatchTimeHours } from "@/lib/analytics/period";
import { formatDisplayDateUtc } from "@/lib/shared-formatting";
import { formatCtr, formatImpressions } from "@/lib/reach-reports/reach-format";
import { AnalyticsDataStrip } from "./analytics-data-strip";
import { AnalyticsLineChart } from "./analytics-line-chart";
import { OperationOverlay, useOperation, LoadingIndicator } from "./operation-progress";
import { MetricDelta } from "./metric-delta";
import { useReachSummary } from "./use-reach-summary";
import { useTopVideos } from "./use-top-videos";
import { VideoPerformanceTable } from "./video-performance-table";

/**
 * Studio-parity Slice O1 (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §2.4) -- real
 * Studio's own 3 Overview cards act as a tab strip: clicking one selects it (redraws the single
 * chart below using that metric) and reveals a short explanation of what it means. No new API call
 * -- every number here is already fetched by `fetchOverview`, this only changes what's plotted.
 */
type OverviewMetricKey = "views" | "watchTimeHours" | "subscribers" | "impressions" | "ctr";

const OVERVIEW_METRIC_INFO: Record<OverviewMetricKey, { label: string; explain: string }> = {
  views: {
    label: "Views",
    explain: "How many times your videos were watched in this period, compared with the previous period of the same length.",
  },
  watchTimeHours: {
    label: "Watch time (hours)",
    explain:
      "Total time viewers spent watching your videos in this period, compared with the previous period. Includes public, private, unlisted, and deleted videos.",
  },
  subscribers: {
    label: "Subscribers",
    explain: "Net change in subscribers (gained minus lost) in this period, compared with the previous period.",
  },
  impressions: {
    label: "Impressions",
    explain:
      "How many times YouTube showed your video thumbnails to viewers in this period (from the daily Reporting API files this app downloads). Only days since the report subscription started exist, so there is no comparison with the previous period.",
  },
  ctr: {
    label: "Click-through rate",
    explain:
      "The share of thumbnail impressions that led to a view. Over a period it is impressions-weighted (total clicks divided by total impressions), never an average of daily rates.",
  },
};

type SyncedChannel = {
  channelId: string;
  title: string;
};

type ChannelOverview = {
  channelId: string;
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  daily: Array<{
    date: string;
    views: number;
    estimatedMinutesWatched: number;
    subscribersGained: number;
    subscribersLost: number;
  }>;
  currentTotals: {
    views: number;
    estimatedMinutesWatched: number;
    subscribersGained: number;
    subscribersLost: number;
  };
  previousTotals: {
    views: number;
    estimatedMinutesWatched: number;
    subscribersGained: number;
    subscribersLost: number;
  };
  viewCountingChangeInComparison?: boolean;
  /** BL-120 */
  source?: "live" | "local";
  collectedAt?: string | null;
  channelStartDate: string | null;
  previousPeriod: { status: "full" | "partial" | "predates_channel"; note: string };
  provisionalFromDate: string;
  granularity: "day" | "week" | "month";
  buckets: Array<{ periodStart: string; periodEnd: string; views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number }> | null;
};

type DataQualityReport = {
  coveredDates: string[];
  uncoveredDates: string[];
  tooRecentDates: string[];
  videosWithSkips: Array<{ videoId: string; skipCount: number; lastSkippedAt: string }>;
  notApplicableRange?: { startDate: string; endDate: string } | null;
  uncoveredRanges?: Array<{ startDate: string; endDate: string }>;
};

type Granularity = "day" | "week" | "month";
const GRANULARITY_OPTIONS: Array<{ key: Granularity; label: string }> = [
  { key: "day", label: "Days" },
  { key: "week", label: "Weeks" },
  { key: "month", label: "Months" },
];

const PERIOD_OPTIONS = [
  { days: 7, label: "Last 7 days" },
  { days: 28, label: "Last 28 days" },
  { days: 90, label: "Last 90 days" },
  { days: 365, label: "Last 365 days" },
] as const;

export function ChannelOverviewPanel({ subscriberCount }: { subscriberCount?: string }) {
  const op = useOperation();
  const { runBlocking } = op;
  const [channel, setChannel] = useState<SyncedChannel | null>(null);
  const [loadingChannel, setLoadingChannel] = useState(true);
  const [periodDays, setPeriodDays] = useState<number>(28);

  const [overview, setOverview] = useState<ChannelOverview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [granularity, setGranularity] = useState<Granularity>("day");
  const [refreshingLive, setRefreshingLive] = useState(false);
  const [coverageReloadKey, setCoverageReloadKey] = useState(0);

  const { topVideos: topContent, loading: loadingTopContent, refetch: refetchTopVideos } = useTopVideos(
    channel?.channelId ?? null,
    periodDays,
    10
  );
  const { reach, loaded: reachLoaded, reload: reloadReach } = useReachSummary(channel?.channelId ?? null, periodDays);

  const [dataQuality, setDataQuality] = useState<DataQualityReport | null>(null);

  const [collecting, setCollecting] = useState(false);
  const [collectMessage, setCollectMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const [selectedMetric, setSelectedMetric] = useState<OverviewMetricKey>("views");
  const [openMetricInfo, setOpenMetricInfo] = useState<OverviewMetricKey | null>(null);
  const metricCardsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMetricInfo) return;
    function handleClickOutside(event: MouseEvent) {
      if (metricCardsRef.current && !metricCardsRef.current.contains(event.target as Node)) {
        setOpenMetricInfo(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openMetricInfo]);

  const selectMetricCard = useCallback((metric: OverviewMetricKey) => {
    setSelectedMetric(metric);
    setOpenMetricInfo((current) => (current === metric ? null : metric));
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
        if (active) setChannel(active);
      } finally {
        if (!cancelled) setLoadingChannel(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Stored channel totals first (no quota); `refresh` forces a live read (BL-120, owner decision 2026-10-04).
  // Only the response of the request that started LAST is applied (a slower earlier one never overwrites a newer period/granularity), and a
  // failed live refresh keeps the stored overview already on screen (it shows the error instead of throwing the data away).
  const latestOverviewRequest = useRef(0);
  const fetchOverview = useCallback(async (channelId: string, days: number, grain: Granularity, refresh = false) => {
    const requestId = ++latestOverviewRequest.current;
    const isLatest = () => requestId === latestOverviewRequest.current;
    setLoadingOverview(true);
    setOverviewError(null);
    try {
      const { startDate, endDate } = computeDefaultPeriodRange(days);
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/analytics/overview?startDate=${startDate}&endDate=${endDate}&granularity=${grain}${
          refresh ? "&refresh=1" : ""
        }`
      );
      const data = await res.json();
      if (!isLatest()) return;
      if (!res.ok) {
        setOverviewError(data.message ?? "Failed to load channel analytics");
        if (!refresh) setOverview(null);
        return;
      }
      setOverview(data as ChannelOverview);
    } catch {
      if (!isLatest()) return;
      setOverviewError("Failed to load channel analytics");
      if (!refresh) setOverview(null);
    } finally {
      if (isLatest()) setLoadingOverview(false);
    }
  }, []);

  // Read-only diagnostic (Phase 8 follow-up, slice 2) -- scoped to the same range "Top content"
  // uses (the locally-collected data window), since that's what this is actually answering:
  // "can I trust the numbers 'Top content' just showed for this period." Failure is silent
  // (dataQuality stays null) -- this is a nice-to-have annotation, not load-bearing for the rest
  // of the panel.
  const latestQualityRequest = useRef(0);
  const fetchDataQuality = useCallback(async (channelId: string, days: number) => {
    // Reset first, not just on success (found by independent review, 2026-09-23): without this,
    // a failed request after a channel/period switch left the PREVIOUS channel's/period's warning
    // banner showing indefinitely, since the old code only ever set state on the success path.
    // Accepted tradeoff (round 2 of that same review): this also means the banner briefly
    // disappears and reappears on every period switch even when the new data is identical -- a
    // visible flicker, but this is a nice-to-have annotation (see this component's own doc
    // comment on `fetchDataQuality`), not something worth a separate "don't flicker on an
    // unchanged result" cache layer for.
    const requestId = ++latestQualityRequest.current;
    setDataQuality(null);
    try {
      const { startDate, endDate } = computeDefaultPeriodRange(days);
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/analytics/data-quality?startDate=${startDate}&endDate=${endDate}`
      );
      const data = await res.json();
      if (res.ok && requestId === latestQualityRequest.current) setDataQuality(data as DataQualityReport);
    } catch {
      // Non-fatal (see doc comment above) -- dataQuality already reset to null above.
    }
  }, []);

  useEffect(() => {
    if (!channel) return;
    void fetchOverview(channel.channelId, periodDays, granularity);
    void fetchDataQuality(channel.channelId, periodDays);
  }, [channel, periodDays, granularity, fetchOverview, fetchDataQuality]);

  const handleRefreshLive = useCallback(async () => {
    if (!channel) return;
    setRefreshingLive(true);
    try {
      await fetchOverview(channel.channelId, periodDays, granularity, true);
    } finally {
      setRefreshingLive(false);
    }
  }, [channel, periodDays, granularity, fetchOverview]);

  // Manual counterpart to the daily background auto-collect (dashboard.tsx's own mount effect) --
  // same underlying endpoint `AnalyticsManager`'s own "Collect now" button already calls
  // (`AGENTS.md` §D, one collection implementation), just surfaced here in the primary Overview
  // view instead of only behind the "Show raw collected data" disclosure (owner request,
  // 2026-09-25: a visible manual trigger here, matching Content's own "Sync now" button).
  // `analytics_data_current` (YouTube itself hasn't refreshed since the last real collection) is
  // shown as an informational, not an error, message -- it isn't something to "fix."
  const handleCollect = useCallback(async () => {
    if (!channel) return;
    setCollecting(true);
    setCollectMessage(null);
    try {
      // startDate/endDate are required by collectMetricsInputSchema -- reuse the exact same
      // "ends yesterday, spans the currently-selected period" range already computed for
      // fetchOverview/fetchDataQuality above, so a manual collect covers what's actually being
      // viewed (found live, 2026-09-25: an empty body failed schema validation with "Invalid
      // collect metrics input", since these two fields have no default).
      const { startDate, endDate } = computeDefaultPeriodRange(periodDays);
      const { res, data } = await runBlocking({
        title: "Collecting YouTube Analytics",
        track: { channelId: channel.channelId, kind: "analytics-collect" },
        quotaServices: ["analytics"],
        request: async () => {
          const res = await fetch(`/api/channels/${encodeURIComponent(channel.channelId)}/analytics/collect`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ startDate, endDate }),
          });
          return { res, data: await res.json() };
        },
        failureOf: ({ res, data }) =>
          res.ok || data.error === "analytics_data_current" ? null : (data.message ?? data.error ?? `Error ${res.status}`),
        summarize: ({ data }) =>
          typeof data.videoCount === "number" ? `${data.videoCount} video${data.videoCount === 1 ? "" : "s"} queried.` : null,
      });
      if (!res.ok) {
        if (data.error === "analytics_data_current") {
          setCollectMessage({ kind: "info", text: data.message ?? "Analytics data is already up to date for today." });
        } else {
          setCollectMessage({ kind: "error", text: data.message ?? data.error ?? `Error ${res.status}` });
        }
        return;
      }
      const skipped = Array.isArray(data.skippedVideoIds) ? data.skippedVideoIds.length : 0;
      setCollectMessage({
        kind: skipped > 0 && data.upsertsIssued === 0 ? "error" : "info",
        text:
          skipped > 0
            ? `Collected with ${skipped} video${skipped === 1 ? "" : "s"} skipped (see details below).`
            : "Data refreshed.",
      });
      await Promise.all([
        fetchOverview(channel.channelId, periodDays, granularity),
        refetchTopVideos(),
        fetchDataQuality(channel.channelId, periodDays),
        reloadReach(),
      ]);
      setCoverageReloadKey((key) => key + 1);
    } catch {
      setCollectMessage({ kind: "error", text: "Failed to collect analytics data." });
    } finally {
      setCollecting(false);
    }
  }, [channel, periodDays, granularity, fetchOverview, refetchTopVideos, fetchDataQuality, reloadReach, runBlocking]);

  const reachReady = reach?.state === "ready";
  const chartData = useMemo(() => {
    if (selectedMetric === "impressions" || selectedMetric === "ctr") {
      if (!reachReady || !reach) return [];
      return reach.daily
        .filter((row) => selectedMetric === "impressions" || row.ctr !== null)
        .map((row) => ({ date: row.date, value: selectedMetric === "impressions" ? row.impressions : (row.ctr as number) * 100 }));
    }
    if (!overview) return [];
    const rows =
      granularity !== "day" && overview.buckets
        ? overview.buckets.map((bucket) => ({ date: bucket.periodStart, ...bucket }))
        : overview.daily;
    return rows.map((row) => {
      switch (selectedMetric) {
        case "watchTimeHours":
          return { date: row.date, value: row.estimatedMinutesWatched / 60 };
        case "subscribers":
          return { date: row.date, value: row.subscribersGained - row.subscribersLost };
        case "views":
        default:
          return { date: row.date, value: row.views };
      }
    });
  }, [overview, selectedMetric, granularity, reach, reachReady]);

  const chartFormatValue = useCallback(
    (value: number) => {
      switch (selectedMetric) {
        case "watchTimeHours":
          return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} hours`;
        case "subscribers":
          return `${value >= 0 ? "+" : ""}${value.toLocaleString()} subscribers`;
        case "impressions":
          return `${formatImpressions(value)} impressions`;
        case "ctr":
          return `${value.toFixed(2)}% click-through rate`;
        case "views":
        default:
          return `${value.toLocaleString()} views`;
      }
    },
    [selectedMetric]
  );

  const periodLabel = PERIOD_OPTIONS.find((p) => p.days === periodDays)?.label.toLowerCase().replace("last ", "previous ") ?? "previous period";

  if (loadingChannel) {
    return <LoadingIndicator className="text-sm text-zinc-400" />;
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
      <OperationOverlay state={op.state} onCancel={op.requestCancel} onClose={op.reset} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-zinc-300">Overview</h3>
        <div className="flex flex-wrap items-center gap-3">
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
          <button
            onClick={handleCollect}
            disabled={collecting}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {collecting ? "Collecting..." : "Collect now"}
          </button>
        </div>
      </div>

      {collectMessage && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            collectMessage.kind === "error"
              ? "border-red-900 bg-red-950/50 text-red-400"
              : "border-zinc-800 bg-zinc-900 text-zinc-300"
          }`}
        >
          {collectMessage.text}
        </div>
      )}

      {overviewError && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">{overviewError}</div>
      )}

      {loadingOverview && !overview ? (
        <LoadingIndicator className="text-sm text-zinc-400" />
      ) : overview ? (
        <>
          <AnalyticsDataStrip
            key={channel.channelId}
            channelId={channel.channelId}
            overview={overview}
            dataQuality={dataQuality}
            refreshing={refreshingLive}
            onRefreshLive={handleRefreshLive}
            reloadKey={coverageReloadKey}
          />
          {overview.viewCountingChangeInComparison && (
            <p className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
              YouTube changed how views are counted on 27 Aug 2026 (a view now counts as soon as playback starts).
              This period and the one it is compared with use different methods, so the views change is not
              like-for-like.
            </p>
          )}
          <div ref={metricCardsRef} className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800 sm:grid-cols-3 lg:grid-cols-5">
            <button
              type="button"
              onClick={() => selectMetricCard("views")}
              aria-pressed={selectedMetric === "views"}
              className={`space-y-1 p-4 text-left transition-colors ${
                selectedMetric === "views" ? "bg-zinc-800 ring-1 ring-inset ring-indigo-500/60" : "bg-zinc-900 hover:bg-zinc-800/60"
              }`}
            >
              <div className="text-xs text-zinc-500">Views</div>
              <div className="text-2xl font-semibold text-zinc-100">{overview.currentTotals.views.toLocaleString()}</div>
              <MetricDelta
                percent={computePercentChange(overview.currentTotals.views, overview.previousTotals.views)}
                periodLabel={periodLabel}
                previousStatus={overview.previousPeriod.status}
              />
            </button>
            <button
              type="button"
              onClick={() => selectMetricCard("watchTimeHours")}
              aria-pressed={selectedMetric === "watchTimeHours"}
              className={`space-y-1 p-4 text-left transition-colors ${
                selectedMetric === "watchTimeHours" ? "bg-zinc-800 ring-1 ring-inset ring-indigo-500/60" : "bg-zinc-900 hover:bg-zinc-800/60"
              }`}
            >
              <div className="text-xs text-zinc-500">Watch time (hours)</div>
              <div className="text-2xl font-semibold text-zinc-100">
                {formatWatchTimeHours(overview.currentTotals.estimatedMinutesWatched)}
              </div>
              <MetricDelta
                percent={computePercentChange(
                  overview.currentTotals.estimatedMinutesWatched,
                  overview.previousTotals.estimatedMinutesWatched
                )}
                periodLabel={periodLabel}
                previousStatus={overview.previousPeriod.status}
              />
            </button>
            <button
              type="button"
              onClick={() => selectMetricCard("subscribers")}
              aria-pressed={selectedMetric === "subscribers"}
              className={`space-y-1 p-4 text-left transition-colors ${
                selectedMetric === "subscribers" ? "bg-zinc-800 ring-1 ring-inset ring-indigo-500/60" : "bg-zinc-900 hover:bg-zinc-800/60"
              }`}
            >
              <div className="text-xs text-zinc-500">Subscribers</div>
              <div className="text-2xl font-semibold text-zinc-100">
                {(() => {
                  const net = overview.currentTotals.subscribersGained - overview.currentTotals.subscribersLost;
                  return `${net >= 0 ? "+" : ""}${net.toLocaleString()}`;
                })()}
              </div>
              <MetricDelta
                percent={computePercentChange(
                  overview.currentTotals.subscribersGained - overview.currentTotals.subscribersLost,
                  overview.previousTotals.subscribersGained - overview.previousTotals.subscribersLost
                )}
                periodLabel={periodLabel}
                previousStatus={overview.previousPeriod.status}
              />
            </button>
            {(["impressions", "ctr"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => selectMetricCard(key)}
                aria-pressed={selectedMetric === key}
                className={`space-y-1 p-4 text-left transition-colors ${
                  selectedMetric === key ? "bg-zinc-800 ring-1 ring-inset ring-indigo-500/60" : "bg-zinc-900 hover:bg-zinc-800/60"
                }`}
              >
                <div className="text-xs text-zinc-500">{OVERVIEW_METRIC_INFO[key].label}</div>
                {reachReady && reach ? (
                  <>
                    <div className="text-2xl font-semibold text-zinc-100">
                      {key === "impressions" ? formatImpressions(reach.totals.impressions) : formatCtr(reach.totals.ctr)}
                    </div>
                    <span className="text-xs text-zinc-500">
                      {reach.coverage.firstDate ? `Data since ${formatDisplayDateUtc(reach.coverage.firstDate)}` : "From YouTube Reporting files"}
                    </span>
                  </>
                ) : (
                  <>
                    <div className="text-2xl font-semibold text-zinc-600">—</div>
                    <span className="text-xs text-zinc-500">
                      {reach === null
                        ? reachLoaded
                          ? "Not available"
                          : "Loading…"
                        : reach.state === "no_job"
                          ? "Not set up yet — see Content"
                          : "Waiting for YouTube's first report"}
                    </span>
                  </>
                )}
              </button>
            ))}
          </div>

          {openMetricInfo && (
            <div className="rounded-xl border border-zinc-700 bg-zinc-800 p-3 text-xs leading-relaxed text-zinc-300">
              <span className="font-medium text-zinc-100">{OVERVIEW_METRIC_INFO[openMetricInfo].label}:</span>{" "}
              {OVERVIEW_METRIC_INFO[openMetricInfo].explain}
            </div>
          )}

          {subscriberCount && (
            <p className="text-xs text-zinc-500">
              Current subscribers (all-time): <span className="text-zinc-300">{Number(subscriberCount).toLocaleString()}</span>
            </p>
          )}

          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            {selectedMetric !== "impressions" && selectedMetric !== "ctr" && (
              <div className="mb-2 flex justify-end">
                <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-950/40 p-0.5" role="group" aria-label="Chart granularity">
                  {GRANULARITY_OPTIONS.map((option) => (
                    <button
                      key={option.key}
                      onClick={() => setGranularity(option.key)}
                      aria-pressed={granularity === option.key}
                      className={`rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors ${
                        granularity === option.key ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <AnalyticsLineChart data={chartData} formatValue={chartFormatValue} formatDate={formatChartDate} />
            {granularity !== "day" && selectedMetric !== "impressions" && selectedMetric !== "ctr" && (
              <p className="mt-1 text-xs text-zinc-500">
                Each point is the total of a calendar {granularity}; the first and last point may cover only part of one.
              </p>
            )}
          </div>

          <VideoPerformanceTable rows={topContent} reach={reach} loading={loadingTopContent} />
        </>
      ) : null}
    </div>
  );
}
