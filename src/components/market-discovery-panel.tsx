"use client";

import { FeatureErrorBoundary } from "./feature-error-boundary";
import { MarketChannelAssignment, useMarketAssignments, VisibleToPill } from "./market-channel-assignment";
import { useCallback, useEffect, useRef, useState } from "react";
import { DrawerSection, SideDrawer } from "./side-drawer";
import { LoadingIndicator, OperationOverlay, useOperation } from "./operation-progress";
import { InfoTooltip } from "./info-tooltip";
import { ConfirmDialog } from "./confirm-dialog";
import { formatDisplayDateTime } from "@/lib/shared-formatting";

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
};

/** 1234 → "1.2K", 4560000 → "4.6M" (display only; the stored value is exact). */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(n);
}

/** BL-145: one line of a found channel's observed counts, e.g. "12.3K subscribers · 42 videos · 456K views · since 2019". Exported for its test. */
export function describeCandidateStats(stats: CandidateStats | null): string | null {
  if (!stats) return null;
  const parts = [
    stats.hiddenSubscriberCount ? "subscribers hidden" : stats.subscriberCount !== null ? `${compact(stats.subscriberCount)} subscribers` : null,
    stats.videoCount !== null ? `${compact(stats.videoCount)} video${stats.videoCount === 1 ? "" : "s"}` : null,
    stats.viewCount !== null ? `${compact(stats.viewCount)} views` : null,
    stats.channelPublishedAt ? `since ${stats.channelPublishedAt.slice(0, 4)}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Phase 13 slice 13.4: one search.list call = 1 of YouTube's 100 daily searches (its own quota bucket).

// BL-140 R4 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.5): candidates by status, New first, paged on the server.
// BL-145 (owner, Telegram 2026-10-07, msg 1904): "Watch" now means what it sounds like -- the channel joins the tracked
// list that is collected regularly (the promote action, now called Track). The old "watching" status is no longer
// offered; it appears as a filter only while some candidate still has it (older data).
export const CANDIDATE_FILTERS: { value: DiscoveryCandidateStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "promoted", label: "Tracked" },
  { value: "ignored", label: "Ignored" },
  { value: "archived", label: "Archived" },
  { value: "watching", label: "Shortlisted (old)" },
];

/** The reason a Track pre-fills, editable before saving. Exported for its test. */
export function defaultTrackReason(candidate: { discoveryQuery: string }): string {
  return `Found by the search "${candidate.discoveryQuery}"`;
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
  const [lastResult, setLastResult] = useState<{ candidatesFound: number; candidatesNew: number } | null>(null);
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
        setLoadError(body.message ?? "Failed to load candidates");
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
      setLoadError("Failed to load candidates");
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

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
        title: "Searching YouTube for channels",
        stage: "Running a YouTube search (uses the separate daily search quota)",
        request: async () => {
          const res = await fetch("/api/market-intelligence/discover", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query }),
          });
          return { res, data: await res.json() };
        },
        failureOf: ({ res, data }) => (res.ok ? null : (data.message ?? "Discovery failed")),
        summarize: () => "Search finished.",
      });
      if (!res.ok) {
        setSearchError(data.message ?? "Discovery failed");
        return;
      }
      setLastResult(data);
      await fetchCandidates();
      void refreshSearchUsage();
      onChanged?.();
    } catch {
      setSearchError("Discovery failed");
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
        setActionError(data.message ?? "Failed to update status");
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
        setActionError(data.message ?? "Failed to promote");
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
          Discover channels
          <InfoTooltip>
            A YouTube channel search, run only when you click Search -- never automatic, never scheduled. Each search
            uses 1 of YouTube&rsquo;s 100 searches per day, a separate quota from the daily units budget in Settings →
            API; it resets at midnight Pacific time. A result already on your watchlist is skipped; everything else
            becomes a candidate you can Track (add to the tracked channels that are collected regularly), ignore or archive.
          </InfoTooltip>
        </h3>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search query, e.g. a topic or niche"
          aria-label="Search query"
          className="min-w-64 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
        />
        <button
          onClick={() => setConfirmingSearch(true)}
          disabled={searching || query.trim().length === 0 || searchesLeft === 0}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
        >
          {searching ? "Searching..." : "Search"}
        </button>
        {searchUsage && (
          <span className={`text-xs ${searchesLeft === 0 ? "text-amber-300" : "text-zinc-500"}`}>
            {searchesLeft} of {searchUsage.dailyLimit} searches left today
          </span>
        )}
      </div>

      {lastResult && (
        <p className="text-xs text-zinc-400">
          Found {lastResult.candidatesFound}, {lastResult.candidatesNew} new.
        </p>
      )}
      {searchError && <p className="text-sm text-red-400">{searchError}</p>}
      {actionError && <p className="text-sm text-red-400">{actionError}</p>}

      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Candidate status">
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
            {f.label}
            {data && <span className="ml-1 text-zinc-500">{data.counts[f.value]}</span>}
          </button>
        ))}
      </div>

      {loading && !data && <LoadingIndicator className="text-xs text-zinc-500" />}
      {loadError && <p className="text-sm text-red-400">{loadError}</p>}
      {data && data.total === 0 && (
        <p className="text-sm text-zinc-500">
          {statusFilter === "new" ? "No new candidates. Run a search to find channels." : `No ${(CANDIDATE_FILTERS.find((f) => f.value === statusFilter)?.label ?? statusFilter).toLowerCase()} candidates.`}
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
                    {!candidate.title && <span className="ml-2 text-xs font-normal text-zinc-500">(title expired, see details)</span>}
                  </p>
                  {describeCandidateStats(candidate.stats) && <p className="truncate text-xs text-zinc-300">{describeCandidateStats(candidate.stats)}</p>}
                  <p className="truncate text-xs text-zinc-500">
                    query &ldquo;{candidate.discoveryQuery}&rdquo; &middot; last seen {formatDisplayDateTime(candidate.lastSeenAt)}
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
                        Ignore
                      </button>
                    )}
                    {candidate.status !== "archived" && (
                      <button
                        onClick={() => handleUpdateStatus(candidate.channelId, "archived")}
                        disabled={updatingChannelId === candidate.channelId}
                        className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                      >
                        Archive
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setPromotingChannelId(candidate.channelId);
                        setPromoteReason(defaultTrackReason(candidate));
                      }}
                      disabled={updatingChannelId === candidate.channelId}
                      title="Add to the tracked channels that are collected regularly"
                      className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      Track
                    </button>
                  </div>
                )}
              </div>

              {promotingChannelId === candidate.channelId && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
                  <input
                    value={promoteReason}
                    onChange={(e) => setPromoteReason(e.target.value)}
                    placeholder="Reason for tracking this channel"
                    aria-label="Reason for tracking"
                    className="min-w-72 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                  />
                  <button
                    onClick={() => handleConfirmPromote(candidate.channelId)}
                    disabled={updatingChannelId === candidate.channelId || promoteReason.trim().length === 0}
                    className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    Track channel
                  </button>
                  <button
                    onClick={() => setPromotingChannelId(null)}
                    className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {data && data.total > data.limit && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
          <span>
            Showing {(data.page - 1) * data.limit + 1}–{Math.min(data.total, data.page * data.limit)} of {data.total}
          </span>
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 disabled:opacity-40">
              ‹ Previous
            </button>
            <span>
              Page {data.page} of {Math.ceil(data.total / data.limit)}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= Math.ceil(data.total / data.limit)}
              className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 disabled:opacity-40"
            >
              Next ›
            </button>
          </span>
        </div>
      )}

      {openCandidate && (
        <SideDrawer title={openCandidate.title || openCandidate.channelId} subtitle={`${openCandidate.channelId} · ${openCandidate.status}`} onClose={() => setOpenChannelId(null)}>
          <DrawerSection title="Channel">
            <div className="space-y-1 text-xs text-zinc-400">
              {openCandidate.stats ? (
                <>
                  <p>
                    Subscribers:{" "}
                    {openCandidate.stats.hiddenSubscriberCount ? "hidden by the channel" : (openCandidate.stats.subscriberCount?.toLocaleString("en-US") ?? "—")}
                    {" "}&middot; videos: {openCandidate.stats.videoCount?.toLocaleString("en-US") ?? "—"} &middot; views:{" "}
                    {openCandidate.stats.viewCount?.toLocaleString("en-US") ?? "—"}
                  </p>
                  {openCandidate.stats.channelPublishedAt && <p>Created {formatDisplayDateTime(openCandidate.stats.channelPublishedAt)}</p>}
                  <p className="text-zinc-500">As of {formatDisplayDateTime(openCandidate.stats.observedAt)}</p>
                </>
              ) : (
                <p>No counts observed for this channel.</p>
              )}
            </div>
          </DrawerSection>
          <DrawerSection title="How it was found">
            <div className="space-y-1 text-xs text-zinc-400">
              <p>
                Query &ldquo;{openCandidate.discoveryQuery}&rdquo; ({openCandidate.discoverySource})
              </p>
              {openCandidate.reasonDiscovered && <p>{openCandidate.reasonDiscovered}</p>}
              <p>
                First seen {formatDisplayDateTime(openCandidate.firstSeenAt)} &middot; last seen {formatDisplayDateTime(openCandidate.lastSeenAt)}
              </p>
              {!openCandidate.title && <p>The title expired under YouTube&rsquo;s 30-day rule; it refreshes when a search finds the channel again.</p>}
              <a href={`https://www.youtube.com/channel/${openCandidate.channelId}`} target="_blank" rel="noreferrer" className="text-indigo-300 hover:text-indigo-200">
                Open on YouTube ↗
              </a>
            </div>
          </DrawerSection>
          <DrawerSection title="Visible to agents of">
            <FeatureErrorBoundary label="Channel assignment">
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
          title="Run this search?"
          description={`This uses 1 of YouTube's 100 searches per day (a separate quota; it resets at midnight Pacific time) for the query "${query}".`}
          confirmLabel="Search"
          onCancel={() => setConfirmingSearch(false)}
          onConfirm={handleConfirmSearch}
        />
      )}
    </div>
  );
}
