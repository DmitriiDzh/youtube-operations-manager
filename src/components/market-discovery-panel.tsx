"use client";

import { FeatureErrorBoundary } from "./feature-error-boundary";
import { MarketChannelAssignment, useMarketAssignments, VisibleToPill } from "./market-channel-assignment";
import { useCallback, useEffect, useRef, useState } from "react";
import { DrawerSection, SideDrawer } from "./side-drawer";
import { LoadingIndicator, OperationOverlay, useOperation } from "./operation-progress";
import { InfoTooltip } from "./info-tooltip";
import { ConfirmDialog } from "./confirm-dialog";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import type { Translate, UiTextKey } from "@/lib/ui-text";
import { useUiText } from "./ui-text-provider";

type DiscoveryCandidateStatus = "new" | "watching" | "ignored" | "archived" | "promoted";

type CandidateStats = {
  subscriberCount: number | null;
  hiddenSubscriberCount: boolean;
  videoCount: number | null;
  viewCount: number | null;
  channelPublishedAt: string | null;
  observedAt: string;
};

type DiscoveryCandidate = {
  channelId: string;
  title: string;
  status: DiscoveryCandidateStatus;
  discoverySource: string;
  discoveryQuery: string;
  reasonDiscovered: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** BL-145: public counts observed right after the search that found it; null when unknown. */
  stats: CandidateStats | null;
  /** BL-145: what the latest genre search found of this channel. */
  match: { query: string; videoCount: number; viewCount: number | null } | null;
};

export type SearchResult =
  | { mode: "channels"; candidatesFound: number; candidatesNew: number }
  | { mode: "genre"; videosFound: number; candidatesFound: number; candidatesNew: number; topicChannelsSkipped: number };

/** BL-152: what the pure helpers in this file need to write a line in the interface language (`useUiText()` provides both). */
export type UiFormat = { t: Translate; formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string };

/** BL-145: the line shown after a search. Exported for its test. */
export function describeSearchResult(t: Translate, r: SearchResult): string {
  if (r.mode === "genre") {
    return t("discover.result.genre", { videos: r.videosFound, channels: r.candidatesFound, fresh: r.candidatesNew, skipped: r.topicChannelsSkipped });
  }
  return t("discover.result.channels", { found: r.candidatesFound, fresh: r.candidatesNew });
}

/** BL-145: "3 matching videos · 600 views on them" for a channel a genre search found. Exported for its test. */
export function describeCandidateMatch(ui: UiFormat, match: DiscoveryCandidate["match"]): string | null {
  if (!match) return null;
  return match.viewCount === null
    ? ui.t("discover.match.videos", { count: match.videoCount })
    : ui.t("discover.match.videosViews", { count: match.videoCount, views: compact(ui, match.viewCount) });
}

/** 1234 → "1.2K", 4560000 → "4.6M" (display only; the stored value is exact). BL-152: in the language's own short form (ru "1,2 тыс."). */
function compact(ui: UiFormat, n: number): string {
  return ui.formatNumber(n, { notation: "compact" });
}

/**
 * The count that picks a word's plural form next to a `compact` number: from 1000 up the shown number is "12K"/"12 тыс.",
 * so the word must agree with that, not with the exact count (Russian 12341 would otherwise read "12 тыс. подписчик").
 */
function pluralCount(n: number): number {
  return n >= 1000 ? 1000 : n;
}

/** BL-145: one line of a found channel's observed counts, e.g. "12.3K subscribers · 42 videos · 456K views · since 2019". Exported for its test. */
export function describeCandidateStats(ui: UiFormat, stats: CandidateStats | null): string | null {
  if (!stats) return null;
  const { t } = ui;
  const parts = [
    stats.hiddenSubscriberCount
      ? t("discover.stats.subscribersHidden")
      : stats.subscriberCount !== null
        ? t("discover.stats.subscribers", { count: pluralCount(stats.subscriberCount), n: compact(ui, stats.subscriberCount) })
        : null,
    stats.videoCount !== null ? t("discover.stats.videos", { count: pluralCount(stats.videoCount), n: compact(ui, stats.videoCount) }) : null,
    stats.viewCount !== null ? t("discover.stats.views", { count: pluralCount(stats.viewCount), n: compact(ui, stats.viewCount) }) : null,
    stats.channelPublishedAt ? t("discover.stats.since", { year: stats.channelPublishedAt.slice(0, 4) }) : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Phase 13 slice 13.4: one search.list call = 1 of YouTube's 100 daily searches (its own quota bucket).

// BL-140 R4 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.5): candidates by status, New first, paged on the server.
// BL-145 (owner, Telegram 2026-10-07, msg 1904): "Watch" now means what it sounds like -- the channel joins the tracked
// list that is collected regularly (the promote action, now called Track). The old "watching" status is no longer
// offered; it appears as a filter only while some candidate still has it (older data).
export const CANDIDATE_FILTERS: { value: DiscoveryCandidateStatus; labelKey: UiTextKey; emptyKey: UiTextKey }[] = [
  { value: "new", labelKey: "discover.filter.new", emptyKey: "discover.empty.new" },
  { value: "promoted", labelKey: "discover.filter.promoted", emptyKey: "discover.empty.promoted" },
  { value: "ignored", labelKey: "discover.filter.ignored", emptyKey: "discover.empty.ignored" },
  { value: "archived", labelKey: "discover.filter.archived", emptyKey: "discover.empty.archived" },
  { value: "watching", labelKey: "discover.filter.watching", emptyKey: "discover.empty.watching" },
];

/** The reason a Track pre-fills, editable before saving. Exported for its test. */
export function defaultTrackReason(t: Translate, candidate: { discoveryQuery: string }): string {
  return t("discover.trackReason", { query: candidate.discoveryQuery });
}
const PAGE_SIZE = 25;
type CandidatesPage = { candidates: DiscoveryCandidate[]; total: number; page: number; limit: number; counts: Record<DiscoveryCandidateStatus, number> };

// Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md §7) -- minimal Discovery UI: a
// query box, a styled (never `window.confirm`) cost confirmation, and a candidate list with
// Watch/Ignore/Archive/Promote actions (BL-140 R4: by status, paged, details and visibility in a drawer). Only ever triggered by an explicit click here (owner
// decision 4) -- there is no automatic or scheduled discovery anywhere in this app.
export function MarketDiscoveryPanel({
  active = true,
  onChanged,
  statusFilterRequest,
}: {
  /** Whether the Discover sub-tab is showing; becoming active again refetches the list. */
  active?: boolean;
  /** Runs after a change that moves the summary line's counts (search, status change, promote). */
  onChanged?: () => void;
  /** A status set from outside (the summary's "new discoveries" link); a new nonce re-applies the same status. */
  statusFilterRequest?: { status: DiscoveryCandidateStatus; nonce: number } | null;
} = {}) {
  const ui = useUiText();
  const { t, formatNumber } = ui;
  const op = useOperation();
  const { runBlocking } = op;
  const [statusFilter, setStatusFilter] = useState<DiscoveryCandidateStatus>("new");
  const [page, setPage] = useState(1);
  // A new request from outside replaces the filter. Adjusted during render (the Videos panel's channelFilter pattern).
  const [lastStatusRequest, setLastStatusRequest] = useState(statusFilterRequest ?? null);
  if ((statusFilterRequest ?? null) !== lastStatusRequest) {
    setLastStatusRequest(statusFilterRequest ?? null);
    if (statusFilterRequest) {
      setStatusFilter(statusFilterRequest.status);
      setPage(1);
    }
  }
  const [data, setData] = useState<CandidatesPage | null>(null);
  const candidates = data?.candidates ?? [];
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openChannelId, setOpenChannelId] = useState<string | null>(null);
  const { assignments, connectedChannels, set: setAssignment } = useMarketAssignments("discovery_candidate");
  const [query, setQuery] = useState("");
  const [confirmingSearch, setConfirmingSearch] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<SearchResult | null>(null);
  // BL-145 (owner, msg 1904): searching channel names is not effective, so the genre search (music videos) is the default.
  const [searchMode, setSearchMode] = useState<"genre" | "channels">("genre");
  const [withinDays, setWithinDays] = useState<"" | "30" | "90" | "180" | "365">("");
  const [updatingChannelId, setUpdatingChannelId] = useState<string | null>(null);
  const [promotingChannelId, setPromotingChannelId] = useState<string | null>(null);
  const [promoteReason, setPromoteReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  // Phase 13 slice 13.4: today's use of YouTube's separate 100-searches-per-day bucket.
  const [searchUsage, setSearchUsage] = useState<{ searchesUsedToday: number; dailyLimit: number } | null>(null);
  const refreshSearchUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/market-intelligence/discover");
      if (res.ok) setSearchUsage(await res.json());
    } catch {
      // Non-fatal: the counter just stays hidden.
    }
  }, []);
  useEffect(() => {
    void refreshSearchUsage();
  }, [refreshSearchUsage]);

  const fetchCandidates = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), status: statusFilter });
      const res = await fetch(`/api/market-intelligence/discovery-candidates?${params.toString()}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(body.message ?? t("discover.loadFailed"));
        return;
      }
      setLoadError(null);
      // An action can empty the last page (e.g. the only New candidate on page 3 was ignored): step back a page.
      if (body.candidates.length === 0 && body.total > 0 && page > 1) {
        setPage(Math.max(1, Math.ceil(body.total / PAGE_SIZE)));
        return;
      }
      setData(body);
    } catch {
      setLoadError(t("discover.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, t]);

  useEffect(() => {
    void fetchCandidates();
  }, [fetchCandidates]);

  // Every sub-tab stays mounted (BL-140 R1), so a change made in another sub-tab (a promoted candidate, an approved
  // collection) is picked up when this one is shown again (BL-140 review).
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      void fetchCandidates();
      // BL-145 (P3): an Inbox approval or the Pacific-midnight reset changes the count while Discover is hidden.
      void refreshSearchUsage();
    }
    wasActive.current = active;
  }, [active, fetchCandidates, refreshSearchUsage]);

  // BL-145 (P3): while Discover is shown, the searches-left counter stays current (midnight reset, other devices).
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refreshSearchUsage(), 60_000);
    return () => clearInterval(timer);
  }, [active, refreshSearchUsage]);

  const openCandidate = candidates.find((c) => c.channelId === openChannelId) ?? null;
  const searchesLeft = searchUsage ? Math.max(0, searchUsage.dailyLimit - searchUsage.searchesUsedToday) : null;

  async function handleConfirmSearch() {
    setConfirmingSearch(false);
    setSearching(true);
    setSearchError(null);
    setLastResult(null);
    try {
      const { res, data } = await runBlocking({
        title: t("discover.op.title"),
        stage: t("discover.op.stage"),
        request: async () => {
          const res = await fetch("/api/market-intelligence/discover", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              searchMode === "genre" ? { query, mode: "genre", ...(withinDays ? { publishedWithinDays: Number(withinDays) } : {}) } : { query, mode: "channels" }
            ),
          });
          return { res, data: await res.json() };
        },
        failureOf: ({ res, data }) => (res.ok ? null : (data.message ?? t("discover.searchFailed"))),
        summarize: () => t("discover.op.finished"),
      });
      if (!res.ok) {
        setSearchError(data.message ?? t("discover.searchFailed"));
        return;
      }
      setLastResult(data);
      await fetchCandidates();
      void refreshSearchUsage();
      onChanged?.();
    } catch {
      setSearchError(t("discover.searchFailed"));
    } finally {
      setSearching(false);
    }
  }

  async function handleUpdateStatus(channelId: string, status: "ignored" | "archived") {
    setUpdatingChannelId(channelId);
    setActionError(null);
    try {
      const res = await fetch(`/api/market-intelligence/discovery-candidates/${encodeURIComponent(channelId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.message ?? t("discover.statusFailed"));
        return;
      }
      await fetchCandidates();
      onChanged?.();
    } finally {
      setUpdatingChannelId(null);
    }
  }

  async function handleConfirmPromote(channelId: string) {
    setUpdatingChannelId(channelId);
    setActionError(null);
    try {
      const res = await fetch(`/api/market-intelligence/discovery-candidates/${encodeURIComponent(channelId)}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: promoteReason }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.message ?? t("discover.promoteFailed"));
        return;
      }
      setPromotingChannelId(null);
      setPromoteReason("");
      await fetchCandidates();
      onChanged?.();
    } finally {
      setUpdatingChannelId(null);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <OperationOverlay state={op.state} onClose={op.reset} />
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          {t("discover.title")}
          <InfoTooltip>{t("discover.tooltip")}</InfoTooltip>
        </h3>
      </div>

      <div className="flex flex-wrap gap-1" role="tablist" aria-label={t("discover.mode.aria")}>
        {(
          [
            ["genre", "discover.mode.genre"],
            ["channels", "discover.mode.channels"],
          ] as const
        ).map(([value, labelKey]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={searchMode === value}
            onClick={() => setSearchMode(value)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${searchMode === value ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchMode === "genre" ? t("discover.query.genrePlaceholder") : t("discover.query.channelsPlaceholder")}
          aria-label={t("discover.query.aria")}
          className="min-w-64 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
        />
        {searchMode === "genre" && (
          <select value={withinDays} onChange={(e) => setWithinDays(e.target.value as typeof withinDays)} aria-label={t("discover.within.aria")} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200">
            <option value="">{t("discover.within.any")}</option>
            <option value="30">{t("discover.within.30")}</option>
            <option value="90">{t("discover.within.90")}</option>
            <option value="180">{t("discover.within.180")}</option>
            <option value="365">{t("discover.within.365")}</option>
          </select>
        )}
        <button
          onClick={() => setConfirmingSearch(true)}
          disabled={searching || query.trim().length === 0 || searchesLeft === 0}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
        >
          {searching ? t("discover.searching") : t("discover.search")}
        </button>
        {searchUsage && (
          <span className={`text-xs ${searchesLeft === 0 ? "text-amber-300" : "text-zinc-500"}`}>
            {t("discover.searchesLeft", { left: searchesLeft ?? 0, limit: searchUsage.dailyLimit })}
          </span>
        )}
      </div>

      {lastResult && (
        <p className="text-xs text-zinc-400">
          {describeSearchResult(t, lastResult)}
        </p>
      )}
      {searchError && <p className="text-sm text-red-400">{searchError}</p>}
      {actionError && <p className="text-sm text-red-400">{actionError}</p>}

      <div className="flex flex-wrap gap-1" role="tablist" aria-label={t("discover.statusAria")}>
        {CANDIDATE_FILTERS.filter((f) => f.value !== "watching" || (data?.counts.watching ?? 0) > 0 || statusFilter === "watching").map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={statusFilter === f.value}
            onClick={() => {
              setStatusFilter(f.value);
              setPage(1);
            }}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${statusFilter === f.value ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            {t(f.labelKey)}
            {data && <span className="ml-1 text-zinc-500">{data.counts[f.value]}</span>}
          </button>
        ))}
      </div>

      {loading && !data && <LoadingIndicator className="text-xs text-zinc-500" />}
      {loadError && <p className="text-sm text-red-400">{loadError}</p>}
      {data && data.total === 0 && (
        <p className="text-sm text-zinc-500">
          {t(CANDIDATE_FILTERS.find((f) => f.value === statusFilter)?.emptyKey ?? "discover.empty.new")}
        </p>
      )}

      {candidates.length > 0 && (
        <div className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {candidates.map((candidate) => (
            <div key={candidate.channelId} className="p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => setOpenChannelId(candidate.channelId)} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium text-zinc-100 hover:underline">
                    {candidate.title || candidate.channelId}
                    {!candidate.title && <span className="ml-2 text-xs font-normal text-zinc-500">{t("discover.titleExpired")}</span>}
                  </p>
                  {describeCandidateStats(ui, candidate.stats) && <p className="truncate text-xs text-zinc-300">{describeCandidateStats(ui, candidate.stats)}</p>}
                  {describeCandidateMatch(ui, candidate.match) && <p className="truncate text-xs text-emerald-300/80">{describeCandidateMatch(ui, candidate.match)}</p>}
                  <p className="truncate text-xs text-zinc-500">
                    {t("discover.queryLine", { query: candidate.discoveryQuery, date: formatDisplayDateTime(candidate.lastSeenAt) })}
                  </p>
                </button>
                <span className="text-xs">
                  <VisibleToPill channelIds={assignments.get(candidate.channelId) ?? []} connectedChannels={connectedChannels} />
                </span>
                {candidate.status !== "promoted" && (
                  <div className="flex flex-wrap gap-2">
                    {candidate.status !== "ignored" && (
                      <button
                        onClick={() => handleUpdateStatus(candidate.channelId, "ignored")}
                        disabled={updatingChannelId === candidate.channelId}
                        className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                      >
                        {t("discover.ignore")}
                      </button>
                    )}
                    {candidate.status !== "archived" && (
                      <button
                        onClick={() => handleUpdateStatus(candidate.channelId, "archived")}
                        disabled={updatingChannelId === candidate.channelId}
                        className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                      >
                        {t("discover.archive")}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setPromotingChannelId(candidate.channelId);
                        setPromoteReason(defaultTrackReason(t, candidate));
                      }}
                      disabled={updatingChannelId === candidate.channelId}
                      title={t("discover.trackTitle")}
                      className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {t("discover.track")}
                    </button>
                  </div>
                )}
              </div>

              {promotingChannelId === candidate.channelId && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
                  <input
                    value={promoteReason}
                    onChange={(e) => setPromoteReason(e.target.value)}
                    placeholder={t("discover.reasonPlaceholder")}
                    aria-label={t("discover.reasonAria")}
                    className="min-w-72 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                  />
                  <button
                    onClick={() => handleConfirmPromote(candidate.channelId)}
                    disabled={updatingChannelId === candidate.channelId || promoteReason.trim().length === 0}
                    className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {t("discover.trackChannel")}
                  </button>
                  <button
                    onClick={() => setPromotingChannelId(null)}
                    className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {data && data.total > data.limit && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
          <span>{t("discover.paging.showing", { from: (data.page - 1) * data.limit + 1, to: Math.min(data.total, data.page * data.limit), total: data.total })}</span>
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 disabled:opacity-40">
              {t("discover.paging.previous")}
            </button>
            <span>{t("discover.paging.page", { page: data.page, pages: Math.ceil(data.total / data.limit) })}</span>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= Math.ceil(data.total / data.limit)}
              className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 disabled:opacity-40"
            >
              {t("discover.paging.next")}
            </button>
          </span>
        </div>
      )}

      {openCandidate && (
        <SideDrawer title={openCandidate.title || openCandidate.channelId} subtitle={`${openCandidate.channelId} · ${openCandidate.status}`} onClose={() => setOpenChannelId(null)}>
          <DrawerSection title={t("discover.drawer.channel")}>
            <div className="space-y-1 text-xs text-zinc-400">
              {openCandidate.stats ? (
                <>
                  <p>
                    {t("discover.drawer.counts", {
                      subscribers: openCandidate.stats.hiddenSubscriberCount
                        ? t("discover.drawer.subscribersHidden")
                        : openCandidate.stats.subscriberCount === null
                          ? "—"
                          : formatNumber(openCandidate.stats.subscriberCount),
                      videos: openCandidate.stats.videoCount === null ? "—" : formatNumber(openCandidate.stats.videoCount),
                      views: openCandidate.stats.viewCount === null ? "—" : formatNumber(openCandidate.stats.viewCount),
                    })}
                  </p>
                  {openCandidate.stats.channelPublishedAt && <p>{t("discover.drawer.created", { date: formatDisplayDateTime(openCandidate.stats.channelPublishedAt) })}</p>}
                  <p className="text-zinc-500">{t("discover.drawer.asOf", { date: formatDisplayDateTime(openCandidate.stats.observedAt) })}</p>
                </>
              ) : (
                <p>{t("discover.drawer.noCounts")}</p>
              )}
            </div>
          </DrawerSection>
          <DrawerSection title={t("discover.drawer.howFound")}>
            <div className="space-y-1 text-xs text-zinc-400">
              <p>{t("discover.drawer.query", { query: openCandidate.discoveryQuery, source: openCandidate.discoverySource })}</p>
              {openCandidate.reasonDiscovered && <p>{openCandidate.reasonDiscovered}</p>}
              <p>{t("discover.drawer.seen", { first: formatDisplayDateTime(openCandidate.firstSeenAt), last: formatDisplayDateTime(openCandidate.lastSeenAt) })}</p>
              {!openCandidate.title && <p>{t("discover.drawer.titleExpired")}</p>}
              <a href={`https://www.youtube.com/channel/${openCandidate.channelId}`} target="_blank" rel="noreferrer" className="text-indigo-300 hover:text-indigo-200">
                {t("discover.drawer.openOnYoutube")}
              </a>
            </div>
          </DrawerSection>
          <DrawerSection title={t("assignment.drawerTitle")}>
            <FeatureErrorBoundary label={t("assignment.boundary")}>
              <MarketChannelAssignment
                recordKind="discovery_candidate"
                recordId={openCandidate.channelId}
                onChange={(channelIds) => setAssignment(openCandidate.channelId, channelIds)}
              />
            </FeatureErrorBoundary>
          </DrawerSection>
        </SideDrawer>
      )}

      {confirmingSearch && (
        <ConfirmDialog
          title={t("discover.confirm.title")}
          description={
            searchMode === "genre"
              ? withinDays
                ? t("discover.confirm.genreWithin", { query, days: Number(withinDays) })
                : t("discover.confirm.genre", { query })
              : t("discover.confirm.channels", { query })
          }
          confirmLabel={t("discover.search")}
          onCancel={() => setConfirmingSearch(false)}
          onConfirm={handleConfirmSearch}
        />
      )}
    </div>
  );
}
