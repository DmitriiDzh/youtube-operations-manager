"use client";

import { useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { LoadingIndicator } from "./operation-progress";

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
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const inputClass = "rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200";

export function MarketVideosPanel({
  channelFilter,
  channelFilterNonce,
}: {
  channelFilter?: string | null;
  /** Changes on every request from outside, so asking for the same channel again re-applies it. */
  channelFilterNonce?: number;
} = {}) {
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

  const publishedAfter = DAY_RE.test(afterText.trim()) ? afterText.trim() : "";
  const publishedBefore = DAY_RE.test(beforeText.trim()) ? beforeText.trim() : "";

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), sort });
    if (channelId) params.set("channelId", channelId);
    if (topicId) params.set("topicId", topicId);
    if (q) params.set("q", q);
    if (publishedAfter) params.set("publishedAfter", publishedAfter);
    if (publishedBefore) params.set("publishedBefore", publishedBefore);
    void (async () => {
      try {
        const res = await fetch(`/api/market-intelligence/videos-overview?${params.toString()}`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok) {
          setData(body as VideosPage);
          setError(null);
        } else {
          setError(body?.message ?? "Failed to load Videos.");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load Videos.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, sort, channelId, topicId, q, publishedAfter, publishedBefore]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const first = data && data.total > 0 ? (data.page - 1) * data.limit + 1 : 0;
  const last = data ? Math.min(data.total, data.page * data.limit) : 0;
  const dateInvalid = (text: string) => text.trim() !== "" && !DAY_RE.test(text.trim());

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        Videos
        <InfoTooltip>
          Videos of the watchlist channels, from already-collected data -- never a live YouTube call. Views are the
          latest observed value, with the time they were observed. By YouTube API policy, nothing is computed from other
          channels&rsquo; data, so there is no growth or ranking here.
        </InfoTooltip>
      </h3>

      <div className="flex flex-wrap items-center gap-2" aria-label="Video filters">
        <input type="search" value={qText} onChange={(e) => setQText(e.target.value)} placeholder="Search titles" aria-label="Search titles" className={`${inputClass} w-56`} />
        <select value={channelId} onChange={(e) => { setChannelId(e.target.value); setPage(1); }} aria-label="Channel" className={inputClass}>
          <option value="">All channels</option>
          {(data?.channels ?? []).map((c) => (
            <option key={c.channelId} value={c.channelId}>{c.label}</option>
          ))}
        </select>
        <select value={topicId} onChange={(e) => { setTopicId(e.target.value); setPage(1); }} aria-label="Topic" className={inputClass}>
          <option value="">All topics</option>
          {(data?.topics ?? []).map((t) => (
            <option key={t.topicId} value={t.topicId}>{t.name}</option>
          ))}
        </select>
        <input type="text" value={afterText} onChange={(e) => { setAfterText(e.target.value); setPage(1); }} placeholder="From YYYY-MM-DD" aria-label="Published from" className={`${inputClass} w-32 ${dateInvalid(afterText) ? "border-red-700" : ""}`} />
        <input type="text" value={beforeText} onChange={(e) => { setBeforeText(e.target.value); setPage(1); }} placeholder="To YYYY-MM-DD" aria-label="Published to" className={`${inputClass} w-32 ${dateInvalid(beforeText) ? "border-red-700" : ""}`} />
        <select value={sort} onChange={(e) => { setSort(e.target.value as "published" | "views"); setPage(1); }} aria-label="Sort" className={inputClass}>
          <option value="published">Newest first</option>
          <option value="views">Most views (latest observation)</option>
        </select>
      </div>

      {loading && <LoadingIndicator className="text-xs text-zinc-500" />}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {data && data.total === 0 && (
        <p className="text-xs text-zinc-500">
          {channelId || topicId || q || publishedAfter || publishedBefore
            ? "No videos match these filters."
            : "No videos observed yet -- add a channel in Channels and collect it."}
        </p>
      )}

      {data && data.rows.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead>
                <tr className="text-zinc-500">
                  <th className="pb-1 pr-3 font-medium">Title</th>
                  <th className="pb-1 pr-3 font-medium">Channel</th>
                  <th className="pb-1 pr-3 font-medium">Published</th>
                  <th className="pb-1 pr-3 font-medium">Views (as of)</th>
                  <th className="pb-1 font-medium">Topic</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((v) => (
                  <tr key={v.videoId} className="border-t border-zinc-800 align-top">
                    <td className="py-1 pr-3 text-zinc-200">
                      {v.title === null ? <span className="italic text-zinc-500">Title not captured</span> : v.title}
                    </td>
                    <td className="py-1 pr-3 text-zinc-400">{v.channelHandleOrUrl ?? v.channelId}</td>
                    <td className="py-1 pr-3 whitespace-nowrap text-zinc-400">{v.publishedAt ? formatDisplayDateTime(v.publishedAt) : "—"}</td>
                    <td className="py-1 pr-3 text-zinc-400">
                      {v.viewCount === null ? "—" : v.viewCount.toLocaleString("en-US")}{" "}
                      <span className="text-zinc-600">(as of {formatDisplayDateTime(v.observedAt)})</span>
                    </td>
                    <td className="py-1 text-zinc-400">{v.topics.length === 0 ? "—" : v.topics.map((t) => t.name).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
            <span>
              Showing {first}–{last} of {data.total.toLocaleString("en-US")}
            </span>
            <span className="flex items-center gap-2">
              <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 disabled:opacity-40">
                ‹ Previous
              </button>
              <span>
                Page {data.page} of {pages}
              </span>
              <button type="button" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 disabled:opacity-40">
                Next ›
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
