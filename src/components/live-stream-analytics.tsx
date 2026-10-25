"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BroadcastAnalyticsView, LiveSummary, LiveSummaryFigures } from "@/lib/live-analytics/contracts";
import type { UiTextKey } from "@/lib/ui-text";
import { AnalyticsLineChart } from "./analytics-line-chart";
import { LoadingIndicator } from "./operation-progress";
import { useUiText } from "./ui-text-provider";

// BL-213 (docs/roadmap/plans/LIVE_ANALYTICS_PLAN.md stage 3): «Эфиры» -- how the stream did over the last days, from the viewer
// samples this computer keeps (BL-211) and the encoder's early exits. A read of local data; never a YouTube call. Unknown is
// "—", never 0. Its own fetch: the page's 5-second poll does not carry it. BL-222: where the stream runs on another computer, the
// figures are the summary that computer shared, and the card names it.

type Summary = LiveSummary & {
  range: { from: string; to: string; days: number };
  source?: { kind: "local" } | { kind: "peer"; deviceId: string; hostName: string | null; updatedAt: string };
};

const RANGES: Array<{ days: number; key: UiTextKey }> = [
  { days: 1, key: "live.analytics.range.day" },
  { days: 7, key: "live.analytics.range.week" },
  { days: 30, key: "live.analytics.range.month" },
  { days: 90, key: "live.analytics.range.quarter" },
];

const cardClass = "space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";

function uptime(f: LiveSummaryFigures): number | null {
  const covered = f.onAirMs + f.notLiveMs;
  return covered > 0 ? f.onAirMs / covered : null;
}

/** `remote`: this computer cannot run the stream -- with no shared figures the card says the other computer has not shared any yet. */
export function LiveStreamAnalyticsCard({ base, visible, remote = false }: { base: string; visible: boolean; remote?: boolean }) {
  const { t, formatNumber, language } = useUiText();
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showBroadcasts, setShowBroadcasts] = useState(false);

  // Only the latest request may fill the card: a slower answer for an earlier range or channel is dropped.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    try {
      const response = await fetch(`${base}/analytics?days=${days}`);
      if (!response.ok) throw new Error(t("live.analytics.loadFailed"));
      const data = (await response.json()) as Summary;
      if (request !== latest.current) return;
      setSummary(data);
      setError(null);
    } catch (e) {
      if (request === latest.current) setError(e instanceof Error ? e.message : t("live.analytics.loadFailed"));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [base, days, t]);

  // Another channel: never show the previous channel's figures while its own load.
  useEffect(() => {
    setSummary(null);
    setError(null);
  }, [base]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const dash = "—";
  const hours = (ms: number) => t("live.analytics.hours", { value: formatNumber(ms / 3_600_000, { maximumFractionDigits: 1 }) });
  const viewers = (v: number | null) => (v === null ? dash : formatNumber(v, { maximumFractionDigits: 1 }));
  const percent = (v: number | null) => (v === null ? dash : formatNumber(v, { style: "percent", maximumFractionDigits: 1 }));
  const dateTime = (ms: number) => new Date(ms).toLocaleString(language, { timeZone: "UTC", dateStyle: "short", timeStyle: "short" });

  const totals = summary?.totals ?? null;
  const tiles: Array<{ key: UiTextKey; value: string }> = totals
    ? [
        { key: "live.analytics.onAir", value: hours(totals.onAirMs) },
        { key: "live.analytics.uptime", value: percent(uptime(totals)) },
        { key: "live.analytics.peak", value: viewers(totals.peakViewers) },
        { key: "live.analytics.average", value: viewers(totals.averageViewers) },
        { key: "live.analytics.viewerHours", value: totals.samples > 0 ? formatNumber(totals.viewerHours, { maximumFractionDigits: 1 }) : dash },
        { key: "live.analytics.interruptions", value: formatNumber(totals.interruptions) },
      ]
    : [];
  const pulls = new Map<string, BroadcastAnalyticsView>((summary?.analytics ?? []).map((a) => [a.broadcastId, a]));
  const youtubeConcurrent = (a: BroadcastAnalyticsView | undefined) =>
    !a ? t("live.analytics.yt.pending") : a.status === "unavailable" ? t("live.analytics.yt.unavailable") : a.status === "failed" && !a.concurrent ? t("live.analytics.yt.failed") : `${viewers(a.concurrent?.average ?? null)} / ${viewers(a.concurrent?.peak ?? null)}`;
  const youtubeViews = (a: BroadcastAnalyticsView | undefined, part: "live" | "onDemand") => {
    const value = a?.[part]?.views;
    return typeof value === "number" ? formatNumber(value) : dash;
  };
  const chart = (summary?.hours ?? []).flatMap((h) => (h.averageViewers === null ? [] : [{ date: h.hour, value: h.averageViewers }]));

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-medium text-zinc-100">{t("live.analytics.title")}</h3>
        <div className="flex gap-1" role="group" aria-label={t("live.analytics.rangeLabel")}>
          {RANGES.map((range) => (
            <button
              key={range.days}
              onClick={() => setDays(range.days)}
              aria-pressed={days === range.days}
              className={`rounded-md px-2.5 py-1 text-xs ${days === range.days ? "bg-zinc-100 text-zinc-900" : "text-zinc-300 hover:bg-zinc-800"}`}
            >
              {t(range.key)}
            </button>
          ))}
        </div>
        <button onClick={() => void load()} disabled={loading} className={`${buttonClass} ml-auto`}>
          {t("live.analytics.refresh")}
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        {summary?.source?.kind === "peer"
          ? t("live.analytics.sourcePeer", { host: summary.source.hostName ?? summary.source.deviceId, at: new Date(summary.source.updatedAt).toLocaleString(language) })
          : remote
            ? t("live.analytics.sourceRemote")
            : t("live.analytics.source")}
      </p>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!summary ? (
        !error && <LoadingIndicator className="text-sm text-zinc-400" />
      ) : summary.totals.samples === 0 ? (
        <p className="text-sm text-zinc-500">{t(remote && summary.source?.kind !== "peer" ? "live.analytics.emptyRemote" : "live.analytics.empty")}</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {tiles.map((tile) => (
              <div key={tile.key} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <dt className="text-xs text-zinc-400">{t(tile.key)}</dt>
                <dd className="mt-1 text-lg font-medium text-zinc-100 tabular-nums">{tile.value}</dd>
              </div>
            ))}
          </dl>
          {summary.totals.dataGaps > 0 && <p className="text-xs text-amber-300/80">{t("live.analytics.gaps", { count: String(summary.totals.dataGaps) })}</p>}
          <div>
            <h4 className="mb-2 text-sm text-zinc-300">{t("live.analytics.chartTitle")}</h4>
            <AnalyticsLineChart data={chart} formatValue={(v) => viewers(v)} formatDate={(d) => dateTime(Date.parse(d))} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-400">
                <tr>
                  <th className="py-1 pr-3 font-normal">{t("live.analytics.col.day")}</th>
                  <th className="py-1 pr-3 font-normal">{t("live.analytics.onAir")}</th>
                  <th className="py-1 pr-3 font-normal">{t("live.analytics.uptime")}</th>
                  <th className="py-1 pr-3 font-normal">{t("live.analytics.peak")}</th>
                  <th className="py-1 pr-3 font-normal">{t("live.analytics.average")}</th>
                  <th className="py-1 pr-3 font-normal">{t("live.analytics.viewerHours")}</th>
                  <th className="py-1 pr-3 font-normal">{t("live.analytics.interruptions")}</th>
                </tr>
              </thead>
              <tbody className="text-zinc-200 tabular-nums">
                {[...summary.days].reverse().map((day) => (
                  <tr key={day.date} className="border-t border-zinc-800">
                    {/* ui-text-ignore: a UTC date (data) */}
                    <td className="py-1 pr-3">{day.date}</td>
                    <td className="py-1 pr-3">{hours(day.onAirMs)}</td>
                    <td className="py-1 pr-3">{percent(uptime(day))}</td>
                    <td className="py-1 pr-3">{viewers(day.peakViewers)}</td>
                    <td className="py-1 pr-3">{viewers(day.averageViewers)}</td>
                    <td className="py-1 pr-3">{formatNumber(day.viewerHours, { maximumFractionDigits: 1 })}</td>
                    <td className="py-1 pr-3">{formatNumber(day.interruptions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={() => setShowBroadcasts((v) => !v)} className={buttonClass} aria-expanded={showBroadcasts}>
            {t(showBroadcasts ? "live.analytics.hideBroadcasts" : "live.analytics.showBroadcasts", { count: String(summary.broadcasts.length) })}
          </button>
          {showBroadcasts && (
            <div className="space-y-2 overflow-x-auto">
              <p className="text-xs text-zinc-500">{t("live.analytics.yt.note")}</p>
              <table className="w-full text-left text-xs">
                <thead className="text-zinc-400">
                  <tr>
                    <th className="py-1 pr-3 font-normal">{t("live.analytics.col.broadcast")}</th>
                    <th className="py-1 pr-3 font-normal">{t("live.analytics.col.from")}</th>
                    <th className="py-1 pr-3 font-normal">{t("live.analytics.col.to")}</th>
                    <th className="py-1 pr-3 font-normal">{t("live.analytics.onAir")}</th>
                    <th className="py-1 pr-3 font-normal">{t("live.analytics.peak")}</th>
                    <th className="py-1 pr-3 font-normal">{t("live.analytics.average")}</th>
                    <th className="py-1 pr-3 font-normal">{t("live.analytics.viewerHours")}</th>
                    <th className="py-1 pr-3 font-normal">{t("live.analytics.col.ytConcurrent")}</th>
                    <th className="py-1 pr-3 font-normal">{t("live.analytics.col.ytLiveViews")}</th>
                    <th className="py-1 pr-3 font-normal">{t("live.analytics.col.ytRecordingViews")}</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-200 tabular-nums">
                  {[...summary.broadcasts].reverse().map((b) => (
                    <tr key={b.broadcastId} className="border-t border-zinc-800">
                      <td className="py-1 pr-3">
                        {/* ui-text-ignore: the broadcast's YouTube id (data) */}
                        <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(b.broadcastId)}`} target="_blank" rel="noreferrer" className="font-mono underline hover:text-white">
                          {b.broadcastId}
                        </a>
                      </td>
                      <td className="py-1 pr-3">{dateTime(b.firstSampleAt)}</td>
                      <td className="py-1 pr-3">{dateTime(b.lastSampleAt)}</td>
                      <td className="py-1 pr-3">{hours(b.onAirMs)}</td>
                      <td className="py-1 pr-3">{viewers(b.peakViewers)}</td>
                      <td className="py-1 pr-3">{viewers(b.averageViewers)}</td>
                      <td className="py-1 pr-3">{formatNumber(b.viewerHours, { maximumFractionDigits: 1 })}</td>
                      <td className="py-1 pr-3" title={pulls.get(b.broadcastId)?.final === false ? t("live.analytics.yt.notFinal") : undefined}>
                        {youtubeConcurrent(pulls.get(b.broadcastId))}
                      </td>
                      <td className="py-1 pr-3">{youtubeViews(pulls.get(b.broadcastId), "live")}</td>
                      <td className="py-1 pr-3">{youtubeViews(pulls.get(b.broadcastId), "onDemand")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
