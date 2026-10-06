"use client";

import { useEffect, useRef, useState } from "react";
import { FeatureErrorBoundary } from "./feature-error-boundary";
import { MarketResearchPanel } from "./market-research-panel";
import { MarketVideosPanel } from "./market-videos-panel";
import { MarketDiscoveryPanel } from "./market-discovery-panel";
import { MarketTopicsPanel } from "./market-topics-panel";
import { MarketTrendsPanel } from "./market-trends-panel";
import { MusicChartPanel } from "./music-chart-panel";
import { MarketResearchRequestsPanel } from "./market-research-requests-panel";
import { MarketCollectionRequestsPanel } from "./market-collection-requests-panel";

// BL-140 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4; owner, Telegram 2026-10-06, msgs 1821/1827/1829): the
// Research tab as a summary line plus sub-tabs, instead of nine stacked panels. Every sub-tab stays mounted and is only
// hidden (the Production/Settings pattern), so switching is instant and nothing refetches.

export const RESEARCH_TABS = [
  { value: "inbox", label: "Inbox" },
  { value: "channels", label: "Channels" },
  { value: "videos", label: "Videos" },
  { value: "discover", label: "Discover" },
  { value: "topics", label: "Topics & trends" },
] as const;

export type ResearchSubTab = (typeof RESEARCH_TABS)[number]["value"];

export type ResearchSummary = {
  watchlistCount: number | null;
  warningCount: number | null;
  newDiscoveryCount: number | null;
  searches: { usedToday: number; dailyLimit: number } | null;
  collectionBudget: { dailyBudgetUnits: number | null; unitsSpentToday: number; remainingTodayUnits: number | null } | null;
  pending: { researchRequests: number | null; collectionRequests: number | null; total: number };
};

const SUMMARY_POLL_MS = 30_000;

/** The summary line's parts, in reading order; a part whose source failed is left out. Exported for its test. */
export function describeResearchSummary(summary: ResearchSummary): Array<{ text: string; tone: "plain" | "warn"; goTo?: ResearchSubTab }> {
  const parts: Array<{ text: string; tone: "plain" | "warn"; goTo?: ResearchSubTab }> = [];
  if (summary.watchlistCount !== null) parts.push({ text: `${summary.watchlistCount} channel${summary.watchlistCount === 1 ? "" : "s"} tracked`, tone: "plain", goTo: "channels" });
  if (summary.warningCount) parts.push({ text: `${summary.warningCount} channel${summary.warningCount === 1 ? " needs" : "s need"} attention`, tone: "warn", goTo: "channels" });
  if (summary.newDiscoveryCount) parts.push({ text: `${summary.newDiscoveryCount} new discover${summary.newDiscoveryCount === 1 ? "y" : "ies"}`, tone: "plain", goTo: "discover" });
  if (summary.collectionBudget) {
    const b = summary.collectionBudget;
    parts.push({
      text: b.dailyBudgetUnits === null ? "Automatic collection is off (no daily budget in Settings → API)" : `Collection budget today: ${b.unitsSpentToday} of ${b.dailyBudgetUnits} units`,
      tone: b.dailyBudgetUnits === null ? "warn" : "plain",
    });
  }
  if (summary.searches) parts.push({ text: `Searches left today: ${Math.max(0, summary.searches.dailyLimit - summary.searches.usedToday)} of ${summary.searches.dailyLimit}`, tone: "plain" });
  if (summary.pending.total > 0) parts.push({ text: `${summary.pending.total} request${summary.pending.total === 1 ? "" : "s"} waiting for you`, tone: "warn", goTo: "inbox" });
  return parts;
}

export function ResearchTab({ onPendingChange }: { onPendingChange?: (pending: number) => void }) {
  const [tab, setTab] = useState<ResearchSubTab>("channels");
  const [summary, setSummary] = useState<ResearchSummary | null>(null);
  // The first summary decides the opening sub-tab once (AC-R1-2): Inbox when something waits, otherwise Channels.
  // Later refreshes never move the owner away from what they are looking at.
  const openedOnce = useRef(false);

  // The latest callback, read from inside the poll so a new parent function never restarts the interval.
  const onPendingRef = useRef(onPendingChange);
  useEffect(() => {
    onPendingRef.current = onPendingChange;
  }, [onPendingChange]);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const res = await fetch("/api/market-intelligence/summary");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as ResearchSummary;
        if (cancelled) return;
        setSummary(data);
        onPendingRef.current?.(data.pending.total);
        if (!openedOnce.current) {
          openedOnce.current = true;
          if (data.pending.total > 0) setTab("inbox");
        }
      } catch {
        // Non-fatal: the line keeps its last state until the next poll.
      }
    }
    void refresh();
    const id = setInterval(() => void refresh(), SUMMARY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const pending = summary?.pending.total ?? 0;

  return (
    <div className="space-y-4">
      {summary && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-zinc-400" aria-label="Research summary">
          {describeResearchSummary(summary).map((part) =>
            part.goTo ? (
              <button
                key={part.text}
                type="button"
                onClick={() => setTab(part.goTo as ResearchSubTab)}
                className={`border-b border-dotted ${part.tone === "warn" ? "border-amber-700 text-amber-300" : "border-zinc-600"} hover:text-zinc-100`}
              >
                {part.text}
              </button>
            ) : (
              <span key={part.text} className={part.tone === "warn" ? "text-amber-300" : undefined}>
                {part.text}
              </span>
            )
          )}
        </div>
      )}

      <div className="inline-flex flex-wrap gap-1 rounded-lg bg-zinc-950 p-1" role="tablist" aria-label="Research sections">
        {RESEARCH_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => setTab(t.value)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${tab === t.value ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            {t.label}
            {t.value === "inbox" && pending > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white">{pending}</span>
            )}
          </button>
        ))}
      </div>

      <div className={tab === "inbox" ? "space-y-6" : "hidden"}>
        <p className="text-sm text-zinc-400">Agents&rsquo; requests that wait for your decision. Approving may spend quota; each request shows its cost.</p>
        <FeatureErrorBoundary label="Research — Requests">
          <MarketResearchRequestsPanel />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Research — Collection requests">
          <MarketCollectionRequestsPanel />
        </FeatureErrorBoundary>
      </div>
      <div className={tab === "channels" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label="Research — Watchlist">
          <MarketResearchPanel />
        </FeatureErrorBoundary>
      </div>
      <div className={tab === "videos" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label="Research — Videos">
          <MarketVideosPanel />
        </FeatureErrorBoundary>
      </div>
      <div className={tab === "discover" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label="Research — Discovery">
          <MarketDiscoveryPanel />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Research — Music chart">
          <MusicChartPanel />
        </FeatureErrorBoundary>
      </div>
      <div className={tab === "topics" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label="Research — Topics">
          <MarketTopicsPanel />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Research — Trends">
          <MarketTrendsPanel />
        </FeatureErrorBoundary>
      </div>
    </div>
  );
}
