"use client";

import { FeatureErrorBoundary } from "./feature-error-boundary";
import { MarketChannelAssignment } from "./market-channel-assignment";
import { useCallback, useEffect, useState } from "react";
import { OperationOverlay, useOperation } from "./operation-progress";
import { InfoTooltip } from "./info-tooltip";
import { ConfirmDialog } from "./confirm-dialog";
import { formatDisplayDateTime } from "@/lib/shared-formatting";

type DiscoveryCandidateStatus = "new" | "watching" | "ignored" | "archived" | "promoted";

type DiscoveryCandidate = {
  channelId: string;
  title: string;
  status: DiscoveryCandidateStatus;
  discoverySource: string;
  discoveryQuery: string;
  reasonDiscovered: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

// Phase 13 slice 13.4: one search.list call = 1 of YouTube's 100 daily searches (its own quota bucket).

// Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md §7) -- minimal Discovery UI: a
// query box, a styled (never `window.confirm`) cost confirmation, and a candidate list with
// Watch/Ignore/Archive/Promote actions. Only ever triggered by an explicit click here (owner
// decision 4) -- there is no automatic or scheduled discovery anywhere in this app.
export function MarketDiscoveryPanel() {
  const op = useOperation();
  const { runBlocking } = op;
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [loading, setLoading] = useState(true);
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
      const res = await fetch("/api/market-intelligence/discovery-candidates");
      if (res.ok) {
        const data = await res.json();
        setCandidates(data.candidates ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCandidates();
  }, [fetchCandidates]);

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
    } catch {
      setSearchError("Discovery failed");
    } finally {
      setSearching(false);
    }
  }

  async function handleUpdateStatus(channelId: string, status: "watching" | "ignored" | "archived") {
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
            One search.list-based discovery pass, only ever run when you click the button below --
            never automatic, never scheduled. Costs 100 YouTube API units per search, drawn from the
            same daily budget as the auto-refresh Settings slider. A result already on your
            watchlist is skipped; everything else becomes a candidate you can watch, ignore,
            archive, or promote into the watchlist.
          </InfoTooltip>
        </h3>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search query, e.g. a topic or niche"
          className="min-w-64 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
        />
        <button
          onClick={() => setConfirmingSearch(true)}
          disabled={searching || query.trim().length === 0}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
        >
          {searching ? "Searching..." : "Search (1 of 100 daily searches)"}
        </button>
      </div>

      {searchUsage && (
        <p className="text-xs text-zinc-500">
          {searchUsage.searchesUsedToday} of {searchUsage.dailyLimit} YouTube searches used today (resets at midnight Pacific time)
        </p>
      )}

      {lastResult && (
        <p className="text-xs text-zinc-400">
          Found {lastResult.candidatesFound}, {lastResult.candidatesNew} new.
        </p>
      )}
      {searchError && <p className="text-sm text-red-400">{searchError}</p>}
      {actionError && <p className="text-sm text-red-400">{actionError}</p>}

      {!loading && candidates.length === 0 && <p className="text-sm text-zinc-500">No discovery candidates yet.</p>}

      <div className="space-y-2">
        {candidates.map((candidate) => (
          <div key={candidate.channelId} className="rounded-lg border border-zinc-800 p-3">
            <div className="mb-2">
              <FeatureErrorBoundary label="Channel assignment">
                <MarketChannelAssignment recordKind="discovery_candidate" recordId={candidate.channelId} />
              </FeatureErrorBoundary>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-zinc-100">
                  {candidate.title || candidate.channelId}
                  {!candidate.title && (
                    <span className="ml-2 text-xs font-normal text-zinc-500">
                      (title expired under YouTube&rsquo;s 30-day rule; refreshes when a search finds it again)
                    </span>
                  )}
                </p>
                <p className="text-xs text-zinc-500">
                  {candidate.channelId} &middot; status: {candidate.status} &middot; query: &ldquo;{candidate.discoveryQuery}&rdquo;
                </p>
                <p className="text-xs text-zinc-500">
                  First seen {formatDisplayDateTime(candidate.firstSeenAt)} &middot; last seen {formatDisplayDateTime(candidate.lastSeenAt)}
                </p>
              </div>
              {candidate.status !== "promoted" && (
                <div className="flex flex-wrap gap-2">
                  {candidate.status !== "watching" && (
                    <button
                      onClick={() => handleUpdateStatus(candidate.channelId, "watching")}
                      disabled={updatingChannelId === candidate.channelId}
                      className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      Watch
                    </button>
                  )}
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
                      setPromoteReason("");
                    }}
                    disabled={updatingChannelId === candidate.channelId}
                    className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    Promote
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
                  className="min-w-56 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                />
                <button
                  onClick={() => handleConfirmPromote(candidate.channelId)}
                  disabled={updatingChannelId === candidate.channelId || promoteReason.trim().length === 0}
                  className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  Confirm promote
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
