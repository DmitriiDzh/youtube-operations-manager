"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDisplayDate, resolvePublishDate } from "@/lib/shared-formatting";
import { postChannelSync } from "./channel-sync-client";
import { OperationOverlay, useOperation, LoadingIndicator } from "./operation-progress";
import { DEFAULT_SORT, nextSortState, sortVideos, type SortKey, type SortState } from "./content-sort";
import { VideoDetailModal } from "./video-detail-modal";
import { VideoDetailsPanel } from "./video-details-panel";

type SyncedChannel = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string;
  connectedUserId: string | null;
  connectedAt: string;
  lastSyncedAt: string | null;
};

export type SyncedVideo = {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  thumbnails: Record<string, { url: string; width: number | null; height: number | null }>;
  existingLocalizationLanguages: string[];
  lastSyncedAt: string;
  etag: string | null;
  viewCount: number | null;
  commentCount: number | null;
  likeCount: number | null;
  publishAt: string | null;
};

type PrivacyFilter = "all" | "public" | "unlisted" | "private";

// Owner instruction, 2026-09-26: the "Publish" column shows the video's real publish date once
// it's actually public; while it's still private and scheduled, it shows YouTube's own
// `status.publishAt` (a distinct field from `publishedAt`, only present for a scheduled video);
// otherwise there is nothing to show.
export function formatPublishColumn(video: SyncedVideo): string {
  const date = resolvePublishDate(video);
  return date ? formatDisplayDate(date) : "—";
}

// A tab switch already re-mounts this component (each section is its own page, BL-149; formerly dashboard/page.tsx's conditional tab
// rendering), so this only needs to decide, once per mount, whether the already-local data is
// fresh enough to skip a real YouTube API call -- auto-resyncing on every single mount would
// spend real, finite quota on every tab click (docs/roadmap/plans/TAB_REFRESH_AND_CHANNEL_UI_PLAN.md
// §4, owner-approved policy). "Sync now" remains available for an explicit forced refresh.
const AUTO_RESYNC_STALENESS_MS = 20 * 60 * 1000;
const PAGE_SIZE = 30;

function formatCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className="px-4 py-2 font-medium"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`flex w-full items-center gap-1 uppercase transition-colors hover:text-zinc-300 ${
          align === "right" ? "justify-end" : "justify-start"
        } ${active ? "text-zinc-200" : ""}`}
      >
        {label}
        <span aria-hidden className={active ? "" : "invisible"}>
          {active && sort.direction === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );
}

/**
 * The "Content" tab -- Studio-parity video table (docs/roadmap/plans/STUDIO_PARITY_PLAN.md
 * Slice S2). Formerly "Sync"; renamed since the underlying data (a synced video list) is the
 * same thing Studio's own Content > Videos table shows, not a second, separate concept.
 */
export function ContentManager() {
  const op = useOperation();
  const { runBlocking, attach } = op;
  const [channels, setChannels] = useState<SyncedChannel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");
  const [videos, setVideos] = useState<SyncedVideo[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [privacyFilter, setPrivacyFilter] = useState<PrivacyFilter>("all");
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const [expandedVideoId, setExpandedVideoId] = useState<string | null>(null);
  const [detailsDirty, setDetailsDirty] = useState(false);

  const fetchVideos = useCallback(async (channelId: string) => {
    if (!channelId) {
      setVideos([]);
      return;
    }
    setLoadingVideos(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/videos`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setVideos(data.videos);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingVideos(false);
    }
  }, []);

  /**
   * `background: true` is the automatic resync when the tab opens with stale data: it must NOT dim the
   * whole app (owner-approved plan, ADR 0015: background sync shows no overlay), so it runs plainly.
   * A sync the operator pressed shows the overlay. In both cases "a sync is already running" is waited
   * out rather than shown as an error (see `postChannelSync`).
   */
  const handleSync = useCallback(async (channelId?: string, options: { background?: boolean } = {}) => {
    setSyncing(true);
    setError(null);
    setLastSyncSummary(null);
    try {
      const onConflict = options.background ? "skip" : "retry";
      const { res, data, waitedForOther } = options.background
        ? await postChannelSync(channelId, { onConflict })
        : await runBlocking({
            title: "Syncing the channel from YouTube",
            track: { channelId: channelId ?? null, kind: "channel-sync" },
            quotaServices: ["dataApi"],
            request: () => postChannelSync(channelId, { onConflict }),
            failureOf: ({ res, data }) => (res.ok ? null : String(data?.message ?? data?.error ?? `Error ${res.status}`)),
            summarize: ({ data }) =>
              typeof data?.videoCount === "number" ? `${data.videoCount} video${data.videoCount === 1 ? "" : "s"} synced.` : null,
          });
      if (!res.ok) {
        setError(String(data?.message ?? data?.error ?? `Error ${res.status}`));
        return;
      }
      if (!data) {
        // Another sync (e.g. the dashboard's own) already did the work: just show what it saved.
        if (channelId) await fetchVideos(channelId);
        return;
      }
      void waitedForOther;
      const channel = data.channel as SyncedChannel;
      setLastSyncSummary(
        `Synced "${channel.title}" — ${data.videoCount} video${data.videoCount === 1 ? "" : "s"}`
      );
      setChannels([channel]);
      setSelectedChannelId(channel.channelId);
      await fetchVideos(channel.channelId);
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }, [fetchVideos, runBlocking]);

  // After a reload, follow a sync the server is still running for this channel (ADR 0015). Only syncs:
  // their result is the saved data, which a refresh picks up. (An AI generation's proposals exist only in
  // its original HTTP response, so it is deliberately NOT re-attached -- the unload warning covers it.)
  useEffect(() => {
    if (!selectedChannelId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/operations?channelId=${encodeURIComponent(selectedChannelId)}&kind=channel-sync&active=1`);
        if (!res.ok || cancelled) return;
        const running = ((await res.json()).operations ?? [])[0] as { id: string } | undefined;
        if (!running || cancelled) return;
        setSyncing(true);
        attach(running.id, {
          title: "Syncing the channel from YouTube",
          quotaServices: ["dataApi"],
          onFinished: () => {
            setSyncing(false);
            void fetchVideos(selectedChannelId);
          },
        });
      } catch {
        // Nothing to re-attach to.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedChannelId, attach, fetchVideos]);

  // Only one channel is ever active (docs/decisions/0004-active-channel-read-scoping.md), so
  // there is nothing for the operator to pick -- resolve it implicitly and, per the staleness
  // policy above, either show the cached local list instantly or resync in the background.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingChannels(true);
      try {
        const res = await fetch("/api/channels");
        const data = await res.json();
        if (cancelled || !res.ok || !Array.isArray(data.channels)) return;
        const activeChannels = data.channels as SyncedChannel[];
        setChannels(activeChannels);
        const active = activeChannels[0];
        if (!active) return;
        setSelectedChannelId(active.channelId);

        const lastSyncedMs = active.lastSyncedAt ? new Date(active.lastSyncedAt).getTime() : 0;
        const isStale = Date.now() - lastSyncedMs > AUTO_RESYNC_STALENESS_MS;
        if (isStale) {
          await handleSync(active.channelId, { background: true });
        } else {
          await fetchVideos(active.channelId);
        }
      } finally {
        if (!cancelled) setLoadingChannels(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally mount-only: a tab switch already remounts this component (see the comment
    // above AUTO_RESYNC_STALENESS_MS), so re-running this on every fetchVideos/handleSync
    // identity change would defeat the whole "decide once per mount" point of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredVideos = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matching = videos.filter((video) => {
      if (privacyFilter !== "all" && video.privacyStatus !== privacyFilter) return false;
      if (query && !video.title.toLowerCase().includes(query)) return false;
      return true;
    });
    return sortVideos(matching, sort);
  }, [videos, search, privacyFilter, sort]);

  const handleSort = (key: SortKey) => {
    setSort((current) => nextSortState(current, key));
    setPage(1);
  };

  const pageCount = Math.max(1, Math.ceil(filteredVideos.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount);
  const pageStart = (clampedPage - 1) * PAGE_SIZE;
  const pageVideos = filteredVideos.slice(pageStart, pageStart + PAGE_SIZE);
  // Looked up from the full `videos` list, not just the current page/filter, so the popup stays
  // open and correct even if the operator changes the search/filter/page while it's open.
  const expandedVideo = expandedVideoId ? videos.find((v) => v.videoId === expandedVideoId) ?? null : null;

  return (
    <div className="space-y-4">
      <OperationOverlay state={op.state} onCancel={op.requestCancel} onClose={op.reset} />
      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex flex-wrap items-center gap-3">
          {loadingChannels ? (
            <LoadingIndicator className="text-sm text-zinc-400" />
          ) : !selectedChannelId ? (
            <p className="text-sm text-zinc-400">
              No channel synchronized yet — sign in and this app will pick up your active channel
              automatically.
            </p>
          ) : null}

          {selectedChannelId && (
            <button
              onClick={() => handleSync(selectedChannelId)}
              disabled={syncing}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
            >
              {syncing ? "Syncing..." : "Sync now"}
            </button>
          )}
        </div>

        {selectedChannelId && (
          <p className="text-xs text-zinc-500">
            Last synced:{" "}
            {channels.find((c) => c.channelId === selectedChannelId)?.lastSyncedAt
              ? new Date(
                  channels.find((c) => c.channelId === selectedChannelId)!.lastSyncedAt!
                ).toLocaleString()
              : "never"}
          </p>
        )}

        {lastSyncSummary && (
          <p className="text-sm font-medium text-green-500">{lastSyncSummary}</p>
        )}

        {error && (
          <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">
            {error}
          </div>
        )}
      </div>

      {selectedChannelId && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search by title..."
              className="min-w-48 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm"
            />
            <select
              value={privacyFilter}
              onChange={(e) => {
                setPrivacyFilter(e.target.value as PrivacyFilter);
                setPage(1);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm"
            >
              <option value="all">All</option>
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
            </select>
            <span className="text-sm text-zinc-400">
              {loadingVideos
                ? "Loading..."
                : `${filteredVideos.length} of ${videos.length} video${videos.length === 1 ? "" : "s"}`}
            </span>
          </div>

          <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] table-fixed text-sm">
            <colgroup>
              <col />
              <col className="w-24" />
              <col className="w-28" />
              <col className="w-20" />
              <col className="w-24" />
            </colgroup>
            <thead>
              <tr className="border-b border-zinc-800 text-left text-xs uppercase text-zinc-500">
                <SortableHeader label="Video" sortKey="title" sort={sort} onSort={handleSort} />
                <SortableHeader label="Access" sortKey="privacy" sort={sort} onSort={handleSort} />
                <SortableHeader label="Publish" sortKey="publish" sort={sort} onSort={handleSort} />
                <SortableHeader label="Views" sortKey="views" sort={sort} onSort={handleSort} align="right" />
                <SortableHeader label="Comments" sortKey="comments" sort={sort} onSort={handleSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {pageVideos.map((video) => (
                  <tr
                    key={video.videoId}
                    className="cursor-pointer border-b border-zinc-800/50 transition-colors last:border-b-0 hover:bg-zinc-800/50"
                    onClick={() => {
                      setExpandedVideoId(video.videoId);
                      setDetailsDirty(false);
                    }}
                  >
                    <td className="min-w-0 px-4 py-3">
                      <div className="flex min-w-0 items-start gap-3">
                        {video.thumbnails.default?.url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={video.thumbnails.default.url}
                            alt={video.title}
                            className="h-12 w-16 shrink-0 rounded object-cover"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{video.title}</p>
                          <p className="truncate text-xs text-zinc-500">{video.description || "—"}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {video.existingLocalizationLanguages.length === 0 ? (
                              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
                                No localizations
                              </span>
                            ) : (
                              video.existingLocalizationLanguages.map((lang) => (
                                <span
                                  key={lang}
                                  className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300"
                                >
                                  {lang}
                                </span>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="truncate px-4 py-3 text-zinc-400">{video.privacyStatus}</td>
                    <td className="truncate px-4 py-3 text-zinc-400">{formatPublishColumn(video)}</td>
                    <td className="truncate px-4 py-3 text-right text-zinc-400">
                      {formatCount(video.viewCount)}
                    </td>
                    <td className="truncate px-4 py-3 text-right text-zinc-400">
                      {formatCount(video.commentCount)}
                    </td>
                  </tr>
              ))}
            </tbody>
          </table>
          </div>

          {!loadingVideos && filteredVideos.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-zinc-500">
              {videos.length === 0
                ? 'No videos synchronized yet. Click "Sync now" above.'
                : "No videos match the current filters."}
            </p>
          )}

          {filteredVideos.length > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3 text-sm text-zinc-400">
              <span>
                {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filteredVideos.length)} of{" "}
                {filteredVideos.length}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={clampedPage <= 1}
                  className="rounded-lg border border-zinc-700 px-3 py-1 disabled:opacity-40"
                >
                  Prev
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  disabled={clampedPage >= pageCount}
                  className="rounded-lg border border-zinc-700 px-3 py-1 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {expandedVideo && (
        <VideoDetailModal
          title={expandedVideo.title}
          thumbnailUrl={expandedVideo.thumbnails.default?.url ?? null}
          onClose={() => setExpandedVideoId(null)}
          hasUnsavedChanges={detailsDirty}
        >
          <VideoDetailsPanel
            channelId={expandedVideo.channelId}
            videoId={expandedVideo.videoId}
            onDirtyChange={setDetailsDirty}
          />
        </VideoDetailModal>
      )}
    </div>
  );
}
