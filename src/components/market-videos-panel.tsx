"use client";

import { errorText } from "@/lib/ui-text";
import { useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { formatDisplayDateTime, parseDisplayDate } from "@/lib/shared-formatting";
import { LoadingIndicator } from "./operation-progress";
import { useUiText } from "./ui-text-provider";

// BL-140 R2 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.4): Research → Videos as a server-paged table. The old
// panel received and rendered every observed video at once (4,590 rows on the owner's data). Only observed values with
// their observation time are shown (Phase 13, YouTube API Developer Policies III.E.4.f/h): no velocity or relative
// performance columns, and none may be added.

type VideoRow = {
  videoId: string;
  channelId: string;
  channelHandleOrUrl: string | null;
  title: string | null;
  publishedAt: string | null;
  viewCount: number | null;
  observedAt: string;
  topics: { topicId: string; name: string }[];
};

type VideosPage = {
  rows: VideoRow[];
  total: number;
  page: number;
  limit: number;
  channels: { channelId: string; label: string }[];
  topics: { topicId: string; name: string }[];
};

const PAGE_SIZE = 50;
const inputClass = "rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200";

/** The Videos request for one page: always paged on the server, filters only when set. Exported for its test. */
export function videosQueryParams(input: {
  page: number;
  sort: "published" | "views";
  channelId: string;
  topicId: string;
  q: string;
  publishedAfter: string;
  publishedBefore: string;
}): URLSearchParams {
  const params = new URLSearchParams({ page: String(input.page), limit: String(PAGE_SIZE), sort: input.sort });
  if (input.channelId) params.set("channelId", input.channelId);
  if (input.topicId) params.set("topicId", input.topicId);
  if (input.q) params.set("q", input.q);
  if (input.publishedAfter) params.set("publishedAfter", input.publishedAfter);
  if (input.publishedBefore) params.set("publishedBefore", input.publishedBefore);
  return params;
}

export function MarketVideosPanel({
  active = true,
  channelFilter,
  channelFilterNonce,
}: {
  /** Whether the Videos sub-tab is showing; becoming active again reloads the current page (BL-140 review). */
  active?: boolean;
  channelFilter?: string | null;
  /** Changes on every request from outside, so asking for the same channel again re-applies it. */
  channelFilterNonce?: number;
} = {}) {
  const { t, formatNumber } = useUiText();
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<"published" | "views">("published");
  const [channelId, setChannelId] = useState(channelFilter ?? "");
  const [topicId, setTopicId] = useState("");
  const [qText, setQText] = useState("");
  const [q, setQ] = useState("");
  const [afterText, setAfterText] = useState("");
  const [beforeText, setBeforeText] = useState("");
  const [data, setData] = useState<VideosPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // "Show all in Videos" from a channel's details: a new filter from outside resets to page 1. Adjusted during render
  // (React's "storing information from previous renders" pattern), not in an effect.
  // Shown again after a change elsewhere (a new channel, a collection): reload the current page. Adjusted during render.
  const [reloadKey, setReloadKey] = useState(0);
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setReloadKey((k) => k + 1);
  }

  const [lastChannelFilter, setLastChannelFilter] = useState(channelFilter ?? null);
  const [lastChannelFilterNonce, setLastChannelFilterNonce] = useState(channelFilterNonce);
  if ((channelFilter ?? null) !== lastChannelFilter || channelFilterNonce !== lastChannelFilterNonce) {
    setLastChannelFilter(channelFilter ?? null);
    setLastChannelFilterNonce(channelFilterNonce);
    setChannelId(channelFilter ?? "");
    setPage(1);
  }

  // The title search waits for a pause in typing, so each keystroke is not a request.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(qText.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [qText]);

  // Typed as DD.MM.YYYY (the app's date format); an impossible date such as 31.02.2026 is rejected, never rolled over.
  const toDay = (text: string) => parseDisplayDate(text)?.slice(0, 10) ?? "";
  const publishedAfter = toDay(afterText);
  const publishedBefore = toDay(beforeText);

  useEffect(() => {
    let cancelled = false;
    const params = videosQueryParams({ page, sort, channelId, topicId, q, publishedAfter, publishedBefore });
    void (async () => {
      try {
        const res = await fetch(`/api/market-intelligence/videos-overview?${params.toString()}`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok) {
          setData(body as VideosPage);
          setError(null);
        } else {
          setError(errorText(t, body, t("marketVideos.loadFailed"), { showErrorField: false }));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : t("marketVideos.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, sort, channelId, topicId, q, publishedAfter, publishedBefore, reloadKey, t]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const first = data && data.total > 0 ? (data.page - 1) * data.limit + 1 : 0;
  const last = data ? Math.min(data.total, data.page * data.limit) : 0;
  const dateInvalid = (text: string) => text.trim() !== "" && parseDisplayDate(text) === null;

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        {t("marketVideos.title")}
        <InfoTooltip>{t("marketVideos.info")}</InfoTooltip>
      </h3>

      <div className="flex flex-wrap items-center gap-2" aria-label={t("marketVideos.filtersLabel")}>
        <input type="search" value={qText} onChange={(e) => setQText(e.target.value)} placeholder={t("marketVideos.searchPlaceholder")} aria-label={t("marketVideos.searchPlaceholder")} className={`${inputClass} w-56`} />
        <select value={channelId} onChange={(e) => { setChannelId(e.target.value); setPage(1); }} aria-label={t("marketVideos.channelLabel")} className={inputClass}>
          <option value="">{t("marketVideos.allChannels")}</option>
          {(data?.channels ?? []).map((c) => (
            <option key={c.channelId} value={c.channelId}>{c.label}</option>
          ))}
        </select>
        <select value={topicId} onChange={(e) => { setTopicId(e.target.value); setPage(1); }} aria-label={t("marketVideos.topicLabel")} className={inputClass}>
          <option value="">{t("marketVideos.allTopics")}</option>
          {(data?.topics ?? []).map((topic) => (
            <option key={topic.topicId} value={topic.topicId}>{topic.name}</option>
          ))}
        </select>
        <input type="text" value={afterText} onChange={(e) => { setAfterText(e.target.value); setPage(1); }} placeholder={t("marketVideos.fromPlaceholder")} aria-label={t("marketVideos.publishedFromLabel")} className={`${inputClass} w-32 ${dateInvalid(afterText) ? "border-red-700" : ""}`} />
        <input type="text" value={beforeText} onChange={(e) => { setBeforeText(e.target.value); setPage(1); }} placeholder={t("marketVideos.toPlaceholder")} aria-label={t("marketVideos.publishedToLabel")} className={`${inputClass} w-32 ${dateInvalid(beforeText) ? "border-red-700" : ""}`} />
        <select value={sort} onChange={(e) => { setSort(e.target.value as "published" | "views"); setPage(1); }} aria-label={t("marketVideos.sortLabel")} className={inputClass}>
          <option value="published">{t("marketVideos.sortNewest")}</option>
          <option value="views">{t("marketVideos.sortViews")}</option>
        </select>
      </div>

      {loading && <LoadingIndicator className="text-xs text-zinc-500" />}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {data && data.total === 0 && (
        <p className="text-xs text-zinc-500">
          {channelId || topicId || q || publishedAfter || publishedBefore
            ? t("marketVideos.noMatch")
            : t("marketVideos.noneYet")}
        </p>
      )}

      {data && data.rows.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead>
                <tr className="text-zinc-500">
                  <th className="pb-1 pr-3 font-medium">{t("marketVideos.col.title")}</th>
                  <th className="pb-1 pr-3 font-medium">{t("marketVideos.col.channel")}</th>
                  <th className="pb-1 pr-3 font-medium">{t("marketVideos.col.published")}</th>
                  <th className="pb-1 pr-3 font-medium">{t("marketVideos.col.views")}</th>
                  <th className="pb-1 font-medium">{t("marketVideos.col.topic")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((v) => (
                  <tr key={v.videoId} className="border-t border-zinc-800 align-top">
                    <td className="py-1 pr-3 text-zinc-200">
                      {v.title === null ? <span className="italic text-zinc-500">{t("marketVideos.titleNotCaptured")}</span> : v.title}
                    </td>
                    <td className="py-1 pr-3 text-zinc-400">{v.channelHandleOrUrl ?? v.channelId}</td>
                    <td className="py-1 pr-3 whitespace-nowrap text-zinc-400">{v.publishedAt ? formatDisplayDateTime(v.publishedAt) : "—"}</td>
                    <td className="py-1 pr-3 text-zinc-400">
                      {v.viewCount === null ? "—" : formatNumber(v.viewCount)}{" "}
                      <span className="text-zinc-600">{t("marketVideos.asOf", { date: formatDisplayDateTime(v.observedAt) })}</span>
                    </td>
                    <td className="py-1 text-zinc-400">{v.topics.length === 0 ? "—" : v.topics.map((topic) => topic.name).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
            <span>
              {t("marketVideos.showing", { first, last, total: data.total })}
            </span>
            <span className="flex items-center gap-2">
              <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 disabled:opacity-40">
                {t("marketVideos.previous")}
              </button>
              <span>
                {t("marketVideos.pageOf", { page: data.page, pages })}
              </span>
              <button type="button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 disabled:opacity-40">
                {t("marketVideos.next")}
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
