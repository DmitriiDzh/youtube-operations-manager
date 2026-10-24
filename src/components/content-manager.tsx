"use client";

import { errorText } from "@/lib/ui-text";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDisplayDate, formatDisplayDateTime, isScheduledVideo, resolvePublishDate } from "@/lib/shared-formatting";
import type { UiTextKey } from "@/lib/ui-text";
import { useUiText } from "./ui-text-provider";
import { postChannelSync } from "./channel-sync-client";
import { useRecentSyncConfirm } from "./recent-sync-confirm";
import { OperationOverlay, useOperation, LoadingIndicator } from "./operation-progress";
import { SkeletonTableRows } from "./busy-feedback";
import { DEFAULT_SORT, nextSortState, sortVideos, type ExtraSortKey, type SortKey, type SortState } from "./content-sort";
import { combineExtras, NO_EXTRAS, useVideoExtras, type VideoExtras, type VideoKind } from "./content-video-extras";
import { costUsd } from "./video-cost-dialog";
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
  /** BL-221: from the sync (seconds; null when unknown). */
  durationSeconds?: number | null;
  /** BL-221: YouTube's `snippet.liveBroadcastContent` as of the sync. */
  liveBroadcastContent?: string | null;
};

type PrivacyFilter = "all" | "public" | "unlisted" | "private" | "scheduled";

/** BL-182 (PUBLISHING_PLAN.md §2 stage 1): «Запланировано» is shown and filtered as Studio does (the shared rule). */
const isScheduled = (video: { privacyStatus: string; publishAt: string | null }) => isScheduledVideo(video);

function accessFilterOf(video: { privacyStatus: string; publishAt: string | null }): Exclude<PrivacyFilter, "all"> {
  return isScheduled(video) ? "scheduled" : (video.privacyStatus as Exclude<PrivacyFilter, "all">);
}

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

function formatCount(value: number | null, formatNumber: (n: number) => string): string {
  return value === null ? "—" : formatNumber(value);
}

// BL-221 (docs/roadmap/plans/CONTENT_UX_PLAN.md stage A): the kind chips and badges, and the access column's short labels.
const KIND_ORDER: readonly VideoKind[] = ["video", "live", "recording", "broadcast"];
const KIND_CHIP: Record<VideoKind, UiTextKey> = {
  video: "content.kind.video",
  live: "content.kind.live",
  recording: "content.kind.recording",
  broadcast: "content.kind.broadcast",
};
const KIND_NAME: Record<VideoKind, UiTextKey> = {
  video: "content.kindName.video",
  live: "content.kindName.live",
  recording: "content.kindName.recording",
  broadcast: "content.kindName.broadcast",
};
const KIND_BADGE: Record<Exclude<VideoKind, "video">, { key: UiTextKey; className: string }> = {
  live: { key: "content.badge.live", className: "bg-red-950/70 text-red-300" },
  recording: { key: "content.badge.recording", className: "bg-zinc-800 text-zinc-300" },
  broadcast: { key: "content.badge.broadcast", className: "bg-amber-950/60 text-amber-300" },
};
const ACCESS_ORDER: readonly Exclude<PrivacyFilter, "all">[] = ["public", "unlisted", "private", "scheduled"];
const ACCESS_CHIP: Record<Exclude<PrivacyFilter, "all">, UiTextKey> = {
  public: "content.accessChip.public",
  unlisted: "content.accessChip.unlisted",
  private: "content.accessChip.private",
  scheduled: "content.accessChip.scheduled",
};
const ACCESS_SHORT: Record<string, UiTextKey> = {
  public: "content.accessShort.public",
  unlisted: "content.accessShort.unlisted",
  private: "content.accessShort.private",
  scheduled: "content.accessShort.scheduled",
};
const ACCESS_FULL: Record<string, UiTextKey> = {
  public: "content.privacy.public",
  unlisted: "content.privacy.unlisted",
  private: "content.privacy.private",
  scheduled: "content.privacy.scheduled",
};
const ACCESS_DOT: Record<string, string> = { public: "bg-emerald-500", unlisted: "bg-sky-500", private: "bg-zinc-500", scheduled: "bg-violet-500" };

/** `1:05:09`, `11:55`; null when unknown. */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** «≈$1.70» for an estimate; «<$0.01» already says "about", so it gets no «≈». */
function costLabel(usd: number, estimated: boolean): string {
  const text = costUsd(usd);
  return estimated && !text.startsWith("<") ? `≈${text}` : text;
}

function kindHint(kind: VideoKind | null): UiTextKey | null {
  return kind === "live" ? "content.kindHint.live" : kind === "broadcast" ? "content.kindHint.broadcast" : null;
}

function extraSortValue(extra: VideoExtras, key: ExtraSortKey): number | null {
  switch (key) {
    case "vn":
      return extra.vn ? Number(extra.vn.slice(1)) : null;
    case "views7d":
      return extra.views7d;
    case "ctr":
      return extra.ctr7d;
    case "languages":
      return extra.languages ? extra.languages.present : null;
    case "cost":
      return extra.costUsd;
  }
}

function KindBadge({ kind }: { kind: Exclude<VideoKind, "video"> }) {
  const { t } = useUiText();
  const badge = KIND_BADGE[kind];
  return <span className={`mr-1.5 rounded px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase ${badge.className}`}>{t(badge.key)}</span>;
}

/** BL-221: the video card's top -- what the list knows about the video, and its links on YouTube; the edit form follows. */
function VideoSummary({ video, extra, viewsThrough, reachThrough }: { video: SyncedVideo; extra: VideoExtras; viewsThrough: string | null; reachThrough: string | null }) {
  const { t, formatNumber } = useUiText();
  const dash = "—";
  const count = (value: number | null) => (value === null ? dash : formatNumber(value));
  const items: Array<{ key: UiTextKey; value: string; title?: string }> = [
    { key: "content.summary.vn", value: extra.vn ?? dash },
    { key: "content.summary.kind", value: extra.kind ? t(KIND_NAME[extra.kind]) : dash },
    { key: "content.column.duration", value: formatDuration(video.durationSeconds ?? null) ?? dash },
    { key: "content.column.publish", value: formatPublishColumn(video) },
    { key: "content.column.views", value: count(video.viewCount) },
    { key: "content.summary.views7d", value: count(extra.views7d), title: viewsThrough ? t("content.column.views7dTitle", { date: formatDisplayDate(viewsThrough) }) : undefined },
    {
      key: "content.summary.ctr",
      value: extra.ctr7d === null ? dash : formatNumber(extra.ctr7d, { style: "percent", maximumFractionDigits: 1 }),
      title: reachThrough ? t("content.column.ctrTitle", { date: formatDisplayDate(reachThrough) }) : undefined,
    },
    { key: "content.summary.likes", value: count(video.likeCount) },
    { key: "content.column.comments", value: count(video.commentCount) },
    { key: "content.column.languages", value: extra.languages ? `${extra.languages.present}/${extra.languages.total}` : dash, title: extra.languages?.missing.length ? t("content.languagesMissing", { languages: extra.languages.missing.join(", ") }) : undefined },
    { key: "content.column.cost", value: extra.costUsd !== null ? costLabel(extra.costUsd, extra.costEstimated) : dash },
  ];
  return (
    <div className="mb-4 space-y-2">
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
        {items.map((item) => (
          <div key={item.key} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2 py-1.5" title={item.title}>
            <dt className="truncate text-[10px] uppercase text-zinc-500">{t(item.key)}</dt>
            <dd className="truncate text-sm font-medium tabular-nums text-zinc-100">{item.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-3 text-xs">
        <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`} target="_blank" rel="noreferrer" className="text-sky-400 underline hover:text-sky-300">
          {t("content.summary.openOnYoutube")}
        </a>
        <a href={`https://studio.youtube.com/video/${encodeURIComponent(video.videoId)}/edit`} target="_blank" rel="noreferrer" className="text-sky-400 underline hover:text-sky-300">
          {t("content.summary.openInStudio")}
        </a>
        {/* ui-text-ignore: the video's YouTube id (data) */}
        <span className="font-mono text-zinc-500">{video.videoId}</span>
      </div>
    </div>
  );
}

function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
  title,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
  title?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className="whitespace-nowrap px-3 py-2 font-medium"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      title={title}
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
  const { t, formatNumber } = useUiText();
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
  const [kindFilter, setKindFilter] = useState<"all" | VideoKind>("all");
  // BL-221: bumped after a sync so the list's extras (kind, last 7 days, Vn, cost, languages) are read again.
  const [extrasReload, setExtrasReload] = useState(0);
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
        setError(errorText(t, data, t("common.errorStatus", { status: String(res.status) })));
        return;
      }
      setVideos(data.videos);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingVideos(false);
    }
  }, [t]);

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
        ? await postChannelSync(channelId, { onConflict, t })
        : await runBlocking({
            title: t("content.sync.overlayTitle"),
            track: { channelId: channelId ?? null, kind: "channel-sync" },
            quotaServices: ["dataApi"],
            request: () => postChannelSync(channelId, { onConflict, t }),
            failureOf: ({ res, data }) =>
              res.ok ? null : String(errorText(t, data, t("common.errorStatus", { status: String(res.status) }))),
            summarize: ({ data }) =>
              typeof data?.videoCount === "number" ? t("content.sync.videosSynced", { count: data.videoCount }) : null,
          });
      if (!res.ok) {
        setError(String(errorText(t, data, t("common.errorStatus", { status: String(res.status) }))));
        return;
      }
      if (!data) {
        // Another sync (e.g. the dashboard's own) already did the work: just show what it saved.
        if (channelId) await fetchVideos(channelId);
        return;
      }
      void waitedForOther;
      const channel = data.channel as SyncedChannel;
      const hidden = Array.isArray(data.hiddenRemovedVideoIds) ? data.hiddenRemovedVideoIds.length : 0;
      const summary = t("content.sync.summary", { channel: channel.title, count: Number(data.videoCount) });
      setLastSyncSummary(hidden > 0 ? `${summary}. ${t("content.sync.hiddenRemoved", { count: hidden })}` : summary);
      setChannels([channel]);
      setSelectedChannelId(channel.channelId);
      await fetchVideos(channel.channelId);
      setExtrasReload((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }, [fetchVideos, runBlocking, t]);
  const recentSync = useRecentSyncConfirm(channels.find((c) => c.channelId === selectedChannelId)?.lastSyncedAt, () => void handleSync(selectedChannelId ?? undefined));

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
          title: t("content.sync.overlayTitle"),
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
  }, [selectedChannelId, attach, fetchVideos, t]);

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

  const extrasSources = useVideoExtras(selectedChannelId, extrasReload);
  const extras = useMemo(() => combineExtras(extrasSources), [extrasSources]);
  const extrasOf = useCallback((videoId: string): VideoExtras => extras.get(videoId) ?? NO_EXTRAS, [extras]);
  const kindsKnown = extrasSources.insights !== null;

  const kindCounts = useMemo(() => {
    const counts: Record<VideoKind, number> = { video: 0, live: 0, recording: 0, broadcast: 0 };
    for (const video of videos) {
      const kind = extrasOf(video.videoId).kind;
      if (kind) counts[kind] += 1;
    }
    return counts;
  }, [videos, extrasOf]);
  const accessCounts = useMemo(() => {
    const counts: Record<Exclude<PrivacyFilter, "all">, number> = { public: 0, unlisted: 0, private: 0, scheduled: 0 };
    for (const video of videos) {
      const access = accessFilterOf(video);
      if (access in counts) counts[access] += 1;
    }
    return counts;
  }, [videos]);

  const filteredVideos = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matching = videos.filter((video) => {
      if (privacyFilter !== "all" && accessFilterOf(video) !== privacyFilter) return false;
      if (kindFilter !== "all" && extrasOf(video.videoId).kind !== kindFilter) return false;
      if (query && !video.title.toLowerCase().includes(query) && extrasOf(video.videoId).vn?.toLowerCase() !== query) return false;
      return true;
    });
    return sortVideos(matching, sort, (video, key) => extraSortValue(extrasOf(video.videoId), key));
  }, [videos, search, privacyFilter, kindFilter, sort, extrasOf]);

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
  const lastSyncedAt = channels.find((c) => c.channelId === selectedChannelId)?.lastSyncedAt ?? null;
  const dash = "—";
  const percent = (value: number | null) => (value === null ? dash : formatNumber(value, { style: "percent", maximumFractionDigits: 1 }));
  const viewsTitle = extrasSources.insights?.viewsThrough ? t("content.column.views7dTitle", { date: formatDisplayDate(extrasSources.insights.viewsThrough) }) : t("content.column.views7dNoData");
  const ctrTitle = extrasSources.insights?.reachThrough ? t("content.column.ctrTitle", { date: formatDisplayDate(extrasSources.insights.reachThrough) }) : t("content.column.ctrNoData");

  const chip = (active: boolean) =>
    `rounded-full border px-2.5 py-0.5 text-xs transition-colors ${active ? "border-zinc-500 bg-zinc-700 text-white" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`;

  return (
    <div className="space-y-4">
      {recentSync.dialog}
      <OperationOverlay state={op.state} onCancel={op.requestCancel} onClose={op.reset} />
      {loadingChannels && <LoadingIndicator className="text-sm text-zinc-400" />}
      {!loadingChannels && !selectedChannelId && <p className="text-sm text-zinc-400">{t("content.noChannel")}</p>}
      {lastSyncSummary && <p className="text-sm font-medium text-green-500">{lastSyncSummary}</p>}
      {error && <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">{error}</div>}

      {selectedChannelId && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900">
          {/* BL-221: one toolbar -- search, the kind and access chips, and the sync on the right (no separate sync card). */}
          <div className="space-y-2 border-b border-zinc-800 px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder={t("content.searchPlaceholder")}
                className="min-w-56 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm sm:flex-none"
              />
              <span className="text-sm text-zinc-400">
                {loadingVideos ? t("common.loading") : t("content.shownOfTotal", { shown: filteredVideos.length, count: videos.length })}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-zinc-500" title={lastSyncedAt ? formatDisplayDateTime(lastSyncedAt) : undefined}>
                  {t("content.syncedAt", { time: lastSyncedAt ? formatDisplayDateTime(lastSyncedAt) : t("common.never") })}
                </span>
                <button
                  onClick={recentSync.request}
                  disabled={syncing}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-50"
                >
                  {syncing ? t("common.syncing") : t("common.syncNow")}
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("content.filter.kind")}>
              <button type="button" aria-pressed={kindFilter === "all"} onClick={() => { setKindFilter("all"); setPage(1); }} className={chip(kindFilter === "all")}>
                {t("content.kind.all", { count: videos.length })}
              </button>
              {kindsKnown &&
                KIND_ORDER.filter((kind) => kind === "video" || kindCounts[kind] > 0).map((kind) => (
                  <button key={kind} type="button" aria-pressed={kindFilter === kind} onClick={() => { setKindFilter(kind); setPage(1); }} className={chip(kindFilter === kind)}>
                    {t(KIND_CHIP[kind], { count: kindCounts[kind] })}
                  </button>
                ))}
              <span className="mx-1 h-4 w-px bg-zinc-700" aria-hidden />
              {ACCESS_ORDER.filter((access) => accessCounts[access] > 0).map((access) => (
                <button
                  key={access}
                  type="button"
                  aria-pressed={privacyFilter === access}
                  onClick={() => { setPrivacyFilter((current) => (current === access ? "all" : access)); setPage(1); }}
                  className={chip(privacyFilter === access)}
                >
                  {t(ACCESS_CHIP[access], { count: accessCounts[access] })}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] table-fixed text-sm">
            <colgroup>
              <col />
              <col className="w-16" />
              <col className="w-32" />
              <col className="w-24" />
              <col className="w-32" />
              <col className="w-24" />
              <col className="w-24" />
              <col className="w-20" />
              <col className="w-24" />
              <col className="w-24" />
            </colgroup>
            <thead>
              <tr className="border-b border-zinc-800 text-left text-xs uppercase text-zinc-500">
                <SortableHeader label={t("content.column.video")} sortKey="title" sort={sort} onSort={handleSort} />
                <SortableHeader label={t("content.column.vn")} sortKey="vn" sort={sort} onSort={handleSort} title={t("content.column.vnTitle")} />
                <SortableHeader label={t("content.column.access")} sortKey="privacy" sort={sort} onSort={handleSort} />
                <SortableHeader label={t("content.column.duration")} sortKey="duration" sort={sort} onSort={handleSort} align="right" />
                <SortableHeader label={t("content.column.publish")} sortKey="publish" sort={sort} onSort={handleSort} />
                <SortableHeader label={t("content.column.views")} sortKey="views" sort={sort} onSort={handleSort} align="right" />
                <SortableHeader label={t("content.column.views7d")} sortKey="views7d" sort={sort} onSort={handleSort} align="right" title={viewsTitle} />
                <SortableHeader label={t("content.column.ctr")} sortKey="ctr" sort={sort} onSort={handleSort} align="right" title={ctrTitle} />
                <SortableHeader label={t("content.column.languages")} sortKey="languages" sort={sort} onSort={handleSort} align="right" title={t("content.column.languagesTitle")} />
                <SortableHeader label={t("content.column.cost")} sortKey="cost" sort={sort} onSort={handleSort} align="right" title={t("content.column.costTitle")} />
              </tr>
            </thead>
            <tbody>
              {/* BL-195 stage E: placeholder rows while the first list loads. */}
              {loadingVideos && videos.length === 0 && <SkeletonTableRows rows={8} columns={10} />}
              {pageVideos.map((video) => {
                const extra = extrasOf(video.videoId);
                const access = accessFilterOf(video);
                return (
                  <tr
                    key={video.videoId}
                    className="cursor-pointer border-b border-zinc-800/50 transition-colors last:border-b-0 hover:bg-zinc-800/50"
                    onClick={() => {
                      setExpandedVideoId(video.videoId);
                      setDetailsDirty(false);
                    }}
                  >
                    <td className="min-w-0 px-4 py-2.5">
                      <div className="flex min-w-0 items-center gap-3">
                        {video.thumbnails.default?.url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={video.thumbnails.default.url} alt={video.title} className="h-10 w-16 shrink-0 rounded object-cover" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium" title={video.title}>
                            {extra.kind && extra.kind !== "video" && <KindBadge kind={extra.kind} />}
                            {video.title}
                          </p>
                          <p className="truncate text-xs text-zinc-500">{kindHint(extra.kind) ? t(kindHint(extra.kind)!) : video.description || dash}</p>
                        </div>
                      </div>
                    </td>
                    <td className="truncate px-3 py-2.5 font-mono text-xs text-zinc-300">{extra.vn ?? dash}</td>
                    <td className="truncate px-3 py-2.5 text-zinc-400" title={t(ACCESS_FULL[access] ?? "content.privacy.private")}>
                      <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${ACCESS_DOT[access] ?? "bg-zinc-500"}`} aria-hidden />
                      {ACCESS_SHORT[access] ? t(ACCESS_SHORT[access]) : video.privacyStatus}
                    </td>
                    <td className="truncate px-3 py-2.5 text-right tabular-nums text-zinc-400">{formatDuration(video.durationSeconds ?? null) ?? dash}</td>
                    <td className="truncate px-3 py-2.5 text-zinc-400">{formatPublishColumn(video)}</td>
                    <td className="truncate px-3 py-2.5 text-right tabular-nums text-zinc-400">{formatCount(video.viewCount, formatNumber)}</td>
                    <td className="truncate px-3 py-2.5 text-right tabular-nums text-zinc-300">{formatCount(extra.views7d, formatNumber)}</td>
                    <td className="truncate px-3 py-2.5 text-right tabular-nums text-zinc-400" title={extra.impressions7d !== null ? t("content.impressions", { count: extra.impressions7d }) : undefined}>
                      {percent(extra.ctr7d)}
                    </td>
                    <td
                      className={`truncate px-3 py-2.5 text-right tabular-nums ${!extra.languages ? "text-zinc-500" : extra.languages.missing.length === 0 ? "text-emerald-400" : "text-amber-300"}`}
                      title={extra.languages && extra.languages.missing.length > 0 ? t("content.languagesMissing", { languages: extra.languages.missing.join(", ") }) : undefined}
                    >
                      {extra.languages ? `${extra.languages.present}/${extra.languages.total}` : dash}
                    </td>
                    <td className="truncate px-3 py-2.5 text-right tabular-nums text-zinc-300">
                      {extra.costUsd !== null ? costLabel(extra.costUsd, extra.costEstimated) : dash}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>

          {!loadingVideos && filteredVideos.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-zinc-500">
              {videos.length === 0 ? t("content.empty.noVideos") : t("content.empty.noMatches")}
            </p>
          )}

          {filteredVideos.length > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-3 text-sm text-zinc-400">
              <span>
                {t("content.pageRange", {
                  from: pageStart + 1,
                  to: Math.min(pageStart + PAGE_SIZE, filteredVideos.length),
                  total: filteredVideos.length,
                })}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={clampedPage <= 1}
                  className="rounded-lg border border-zinc-700 px-3 py-1 disabled:opacity-40"
                >
                  {t("content.page.prev")}
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  disabled={clampedPage >= pageCount}
                  className="rounded-lg border border-zinc-700 px-3 py-1 disabled:opacity-40"
                >
                  {t("content.page.next")}
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
          <VideoSummary video={expandedVideo} extra={extrasOf(expandedVideo.videoId)} viewsThrough={extrasSources.insights?.viewsThrough ?? null} reachThrough={extrasSources.insights?.reachThrough ?? null} />
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
