"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { formatDisplayDateTime } from "@/lib/shared-formatting";

// Phase 9 slice 9H, part B (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_B_PLAN.md) -- Market Overview.
// Mirrors getMarketOverviewOutputSchema. A read-only aggregation across the whole watchlist -- no
// mutation actions live here; every action (remove a channel, promote a discovery candidate, change
// a trend's status) stays in that item's own panel further down the Research tab.
type DiscoveryCandidate = {
  channelId: string;
  title: string;
  status: string;
  firstSeenAt: string;
};

type BreakoutVideoOverviewEntry = {
  channelId: string;
  videoId: string;
  ratio: number | null;
  reason: string;
};

type EmergingChannelOverviewEntry = {
  researchChannelId: string;
  recentBreakoutVideoCount: number;
  reasons: string[];
};

type TrendCandidateOverviewEntry = {
  trendCandidateId: string;
  title: string;
  status: string;
  freshness: "fresh" | "needs_attention";
};

type CollectionWarning = {
  channelId: string;
  dataQualityFlags: string[];
  latestRunStatus: "success" | "skipped_quota_limited" | "failed" | null;
  neverObserved: boolean;
};

type MarketOverview = {
  watchlistCount: number;
  newDiscoveries: DiscoveryCandidate[];
  breakoutVideos: BreakoutVideoOverviewEntry[];
  emergingChannels: EmergingChannelOverviewEntry[];
  trendCandidates: TrendCandidateOverviewEntry[];
  collectionWarnings: CollectionWarning[];
};

// Same emerald/neutral pill styling market-trends-panel.tsx already uses for this exact freshness
// value -- reused verbatim, not reworded a second way here (plan §6).
function FreshnessBadge({ freshness }: { freshness: "fresh" | "needs_attention" }) {
  return (
    <span
      className={
        freshness === "fresh"
          ? "rounded-full border border-emerald-800 bg-emerald-950/40 px-1.5 py-0.5 text-emerald-400"
          : "rounded-full border border-zinc-700 px-1.5 py-0.5 text-zinc-500"
      }
    >
      {freshness === "fresh" ? "evidence added recently" : "no recent evidence"}
    </span>
  );
}

export function MarketOverviewPanel() {
  const [overview, setOverview] = useState<MarketOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/market-intelligence/overview");
      if (res.ok) {
        setOverview(await res.json());
      } else {
        const body = await res.json().catch(() => null);
        setError(body?.message ?? "Failed to load Market Overview.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchOverview();
  }, [fetchOverview]);

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        Market Overview
        <InfoTooltip>
          Aggregated across every watchlisted channel, computed entirely from already-collected local
          data -- never a live YouTube call of its own. See the Channels/Trends sections below for the
          full detail behind any figure here.
        </InfoTooltip>
      </h3>

      {loading && <p className="text-xs text-zinc-500">Loading...</p>}
      {!loading && error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && overview && (
        <div className="space-y-4 text-sm">
          <p className="text-xs text-zinc-400">{overview.watchlistCount} channel(s) tracked.</p>

          <section>
            <p className="mb-1 text-xs font-semibold text-zinc-300">New discoveries</p>
            {overview.newDiscoveries.length === 0 ? (
              <p className="text-xs text-zinc-500">No new discoveries -- use Discover channels below.</p>
            ) : (
              <ul className="space-y-1">
                {overview.newDiscoveries.map((c) => (
                  <li key={c.channelId} className="text-xs text-zinc-400">
                    <span className="text-zinc-200">{c.title || c.channelId}</span> ({c.channelId}) -- first seen{" "}
                    {formatDisplayDateTime(c.firstSeenAt)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <p className="mb-1 text-xs font-semibold text-zinc-300">Breakout videos</p>
            {overview.breakoutVideos.length === 0 ? (
              <p className="text-xs text-zinc-500">No breakout videos detected yet.</p>
            ) : (
              <ul className="space-y-1">
                {overview.breakoutVideos.map((v) => (
                  <li key={`${v.channelId}-${v.videoId}`} className="text-xs text-emerald-400">
                    {v.channelId} &middot; {v.videoId}: {v.reason}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <p className="mb-1 text-xs font-semibold text-zinc-300">Emerging channels</p>
            {overview.emergingChannels.length === 0 ? (
              <p className="text-xs text-zinc-500">No emerging channels detected yet.</p>
            ) : (
              <ul className="space-y-1">
                {overview.emergingChannels.map((c) => (
                  <li key={c.researchChannelId} className="text-xs text-emerald-400">
                    {c.researchChannelId}: {c.reasons.join("; ")}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <p className="mb-1 text-xs font-semibold text-zinc-300">Trend candidates</p>
            {overview.trendCandidates.length === 0 ? (
              <p className="text-xs text-zinc-500">No trend candidates recorded yet.</p>
            ) : (
              <ul className="space-y-1">
                {overview.trendCandidates.map((t) => (
                  <li key={t.trendCandidateId} className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-400">
                    <span className="text-zinc-200">{t.title}</span>
                    <span className="rounded-full border border-zinc-700 px-1.5 py-0.5 text-zinc-300">{t.status}</span>
                    <FreshnessBadge freshness={t.freshness} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <p className="mb-1 text-xs font-semibold text-zinc-300">Stale/failed collection warnings</p>
            {overview.collectionWarnings.length === 0 ? (
              <p className="text-xs text-zinc-500">No collection warnings -- every tracked channel looks current.</p>
            ) : (
              <ul className="space-y-1">
                {overview.collectionWarnings.map((w) => (
                  <li key={w.channelId} className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-400">
                    <span className="text-zinc-200">{w.channelId}</span>
                    {w.neverObserved && (
                      <span className="rounded-full border border-zinc-700 px-1.5 py-0.5 text-zinc-400">Never collected</span>
                    )}
                    {w.latestRunStatus === "failed" && (
                      <span className="rounded-full border border-red-800 bg-red-950/40 px-1.5 py-0.5 text-red-400">
                        Last collection attempt failed
                      </span>
                    )}
                    {w.dataQualityFlags.map((flag) => (
                      <span key={flag} className="rounded-full border border-amber-800 bg-amber-950/40 px-1.5 py-0.5 text-amber-400">
                        {flag}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
