"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

type SyncedChannel = {
  channelId: string;
  title: string;
};

type OverviewRow = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  publishedAt: string;
  defaultLanguage: string | null;
  presentLanguages: string[];
  missingLanguages: string[];
  status: "complete" | "missing";
};

type Overview = {
  channelId: string;
  channelTitle: string;
  languages: string[];
  totalVideos: number;
  videos: OverviewRow[];
};

type DetailLocale = {
  language: string;
  remoteTitle: string;
  remoteDescription: string;
};

type Detail = {
  videoId: string;
  originalTitle: string;
  originalDescription: string;
  defaultLanguage: string | null;
  locales: DetailLocale[];
  lastSyncedAt: string;
};

type StatusFilter = "all" | "missing" | "complete";

export function LocalizationManager() {
  const [channels, setChannels] = useState<SyncedChannel[]>([]);
  const [channelId, setChannelId] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedVideoId, setExpandedVideoId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [exporting, setExporting] = useState(false);

  const fetchChannels = useCallback(async () => {
    const res = await fetch("/api/channels");
    const data = await res.json();
    if (res.ok && Array.isArray(data.channels)) {
      setChannels(data.channels);
    }
  }, []);

  const fetchOverview = useCallback(async (id: string) => {
    if (!id) {
      setOverview(null);
      return;
    }
    setLoadingOverview(true);
    setError(null);
    setSelected(new Set());
    setExpandedVideoId(null);
    setDetail(null);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(id)}/localizations`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setOverview(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  useEffect(() => {
    if (channelId) fetchOverview(channelId);
  }, [channelId, fetchOverview]);

  async function toggleExpand(videoId: string) {
    if (expandedVideoId === videoId) {
      setExpandedVideoId(null);
      setDetail(null);
      return;
    }

    setExpandedVideoId(videoId);
    setLoadingDetail(true);
    setDetail(null);
    try {
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/localizations/${encodeURIComponent(videoId)}`
      );
      const data = await res.json();
      if (res.ok) setDetail(data);
    } finally {
      setLoadingDetail(false);
    }
  }

  function toggleSelected(videoId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  }

  const filteredVideos = useMemo(() => {
    if (!overview) return [];
    return overview.videos.filter((v) => {
      if (statusFilter !== "all" && v.status !== statusFilter) return false;
      if (search.trim() && !v.title.toLowerCase().includes(search.trim().toLowerCase())) return false;
      return true;
    });
  }, [overview, statusFilter, search]);

  async function handleExport(scope: "all" | "filtered" | "selected") {
    if (!channelId) return;
    setExporting(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (scope === "selected" && selected.size > 0) {
        params.set("videoIds", [...selected].join(","));
      } else if (scope === "filtered") {
        params.set("videoIds", filteredVideos.map((v) => v.videoId).join(","));
      }

      const url = `/api/channels/${encodeURIComponent(channelId)}/localizations/export${
        params.toString() ? `?${params.toString()}` : ""
      }`;
      const res = await fetch(url);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.message ?? data?.error ?? `Error ${res.status}`);
        return;
      }

      const blob = await res.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = `localizations-${channelId}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <label className="text-xs font-medium text-zinc-400">Channel</label>
        <select
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          className="min-w-48 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"
        >
          <option value="">
            {channels.length > 0 ? "Select a synchronized channel..." : "No channels synchronized yet"}
          </option>
          {channels.map((c) => (
            <option key={c.channelId} value={c.channelId}>
              {c.title}
            </option>
          ))}
        </select>

        {overview && (
          <>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title..."
              className="min-w-40 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm placeholder:text-zinc-600"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"
            >
              <option value="all">All</option>
              <option value="missing">Missing</option>
              <option value="complete">Complete</option>
            </select>
          </>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">{error}</div>
      )}

      {overview && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <span className="text-sm text-zinc-400">
              {loadingOverview
                ? "Loading..."
                : `${filteredVideos.length} of ${overview.totalVideos} videos · languages: ${
                    overview.languages.length > 0 ? overview.languages.join(", ") : "none yet"
                  }`}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => handleExport("selected")}
                disabled={exporting || selected.size === 0}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
              >
                Export selected ({selected.size})
              </button>
              <button
                onClick={() => handleExport("filtered")}
                disabled={exporting || filteredVideos.length === 0}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
              >
                Export filtered ({filteredVideos.length})
              </button>
              <button
                onClick={() => handleExport("all")}
                disabled={exporting}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {exporting ? "Exporting..." : `Export all (${overview.totalVideos})`}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                  <th className="px-3 py-2"></th>
                  <th className="px-3 py-2">Video</th>
                  {overview.languages.map((lang) => (
                    <th key={lang} className="px-3 py-2 text-center">
                      {lang}
                    </th>
                  ))}
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredVideos.map((video) => (
                  <Fragment key={video.videoId}>
                    <tr
                      className="cursor-pointer border-b border-zinc-800/50 transition-colors hover:bg-zinc-800/50"
                      onClick={() => toggleExpand(video.videoId)}
                    >
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(video.videoId)}
                          onChange={() => toggleSelected(video.videoId)}
                          className="h-4 w-4 rounded accent-red-600"
                        />
                      </td>
                      <td className="max-w-xs truncate px-3 py-2 font-medium">{video.title}</td>
                      {overview.languages.map((lang) => (
                        <td key={lang} className="px-3 py-2 text-center">
                          {video.presentLanguages.includes(lang) ? (
                            <span className="text-green-500">✓</span>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                      ))}
                      <td className="px-3 py-2">
                        {video.status === "complete" ? (
                          <span className="rounded bg-green-900/40 px-2 py-0.5 text-xs text-green-400">
                            Complete
                          </span>
                        ) : (
                          <span className="rounded bg-amber-900/40 px-2 py-0.5 text-xs text-amber-400">
                            Missing {video.missingLanguages.length}
                          </span>
                        )}
                      </td>
                    </tr>
                    {expandedVideoId === video.videoId && (
                      <tr className="border-b border-zinc-800/50 bg-zinc-950/50">
                        <td colSpan={overview.languages.length + 3} className="px-4 py-4">
                          {loadingDetail ? (
                            <p className="text-sm text-zinc-500">Loading detail...</p>
                          ) : detail ? (
                            <div className="space-y-3">
                              <div>
                                <p className="text-xs font-medium text-zinc-500">
                                  Original / default language: {detail.defaultLanguage ?? "unset"}
                                </p>
                                <p className="text-sm font-medium">{detail.originalTitle}</p>
                                <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-400">
                                  {detail.originalDescription}
                                </p>
                              </div>
                              {detail.locales.length === 0 ? (
                                <p className="text-xs text-zinc-500">No existing localizations.</p>
                              ) : (
                                <div className="space-y-2 border-t border-zinc-800 pt-3">
                                  {detail.locales.map((locale) => (
                                    <div key={locale.language}>
                                      <p className="text-xs font-medium text-zinc-500">{locale.language}</p>
                                      <p className="text-sm">{locale.remoteTitle}</p>
                                      <p className="mt-0.5 whitespace-pre-wrap text-xs text-zinc-400">
                                        {locale.remoteDescription}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ) : (
                            <p className="text-sm text-red-400">Failed to load detail.</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>

            {!loadingOverview && filteredVideos.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-zinc-500">No videos match the current filters.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
