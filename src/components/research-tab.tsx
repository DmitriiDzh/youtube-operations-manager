"use client";

import { useT } from "./ui-text-provider";
import type { Translate } from "@/lib/ui-text";
import { useCallback, useEffect, useRef, useState } from "react";
import { FeatureErrorBoundary } from "./feature-error-boundary";
import { MarketResearchPanel, type WatchlistStatusFilter } from "./market-research-panel";
import { MarketVideosPanel } from "./market-videos-panel";
import { MarketDiscoveryPanel } from "./market-discovery-panel";
import { MarketTopicsPanel } from "./market-topics-panel";
import { MarketTrendsPanel } from "./market-trends-panel";
import { MusicChartPanel } from "./music-chart-panel";
import { AgentProposalsPanel } from "./agent-proposals-panel";
import { MarketResearchRequestsPanel } from "./market-research-requests-panel";
import { MarketCollectionRequestsPanel } from "./market-collection-requests-panel";

// BL-140 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4; owner, Telegram 2026-10-06, msgs 1821/1827/1829): the
// Research tab as a summary line plus sub-tabs, instead of nine stacked panels. Every sub-tab stays mounted and is only
// hidden (the Production/Settings pattern), so switching is instant and nothing refetches.

import { RESEARCH_TABS, type ResearchSubTab } from "./section-tabs";
export { RESEARCH_TABS, type ResearchSubTab };

export type ResearchSummary = {
  watchlistCount: number | null;
  warningCount: number | null;
  newDiscoveryCount: number | null;
  searches: { usedToday: number; dailyLimit: number } | null;
  collectionBudget: { dailyBudgetUnits: number | null; unitsSpentToday: number; remainingTodayUnits: number | null } | null;
  pending: { researchRequests: number | null; collectionRequests: number | null; agentProposals?: number | null; total: number };
};

const SUMMARY_POLL_MS = 30_000;

/** The summary line's parts, in reading order; a part whose source failed is left out. Exported for its test. */
type SummaryPart = { text: string; tone: "plain" | "warn"; goTo?: ResearchSubTab; filter?: WatchlistStatusFilter };

export function describeResearchSummary(t: Translate, summary: ResearchSummary): SummaryPart[] {
  const parts: SummaryPart[] = [];
  if (summary.watchlistCount !== null) parts.push({ text: t("research.summary.tracked", { count: summary.watchlistCount }), tone: "plain", goTo: "channels" });
  if (summary.warningCount) parts.push({ text: t("research.summary.attention", { count: summary.warningCount }), tone: "warn", goTo: "channels", filter: "needs_attention" });
  if (summary.newDiscoveryCount) parts.push({ text: t("research.summary.newDiscoveries", { count: summary.newDiscoveryCount }), tone: "plain", goTo: "discover" });
  if (summary.collectionBudget) {
    const b = summary.collectionBudget;
    parts.push({
      text: b.dailyBudgetUnits === null ? t("research.summary.collectionOff") : t("research.summary.budget", { spent: b.unitsSpentToday, budget: b.dailyBudgetUnits }),
      tone: b.dailyBudgetUnits === null ? "warn" : "plain",
    });
  }
  if (summary.searches) parts.push({ text: t("research.summary.searchesLeft", { left: Math.max(0, summary.searches.dailyLimit - summary.searches.usedToday), limit: summary.searches.dailyLimit }), tone: "plain" });
  if (summary.pending.total > 0) parts.push({ text: t("research.summary.pending", { count: summary.pending.total }), tone: "warn", goTo: "inbox" });
  return parts;
}

/** Whether a summary should move the tab to Inbox: only the first decision, and only with something pending. */
export function shouldOpenInbox(input: { decided: boolean; pending: number }): boolean {
  return !input.decided && input.pending > 0;
}

export function ResearchTab({
  onPendingChange,
  tab: routeTab,
  onTabChange,
}: {
  onPendingChange?: (pending: number) => void;
  /**
   * BL-149: the sub-tab from the address (`/research/<tab>`), or null on plain `/research`, where the first summary
   * decides (AC-R1-2) and the address is replaced with that sub-tab. Absent (with `onTabChange`) = local state.
   */
  tab?: ResearchSubTab | null;
  onTabChange?: (tab: ResearchSubTab, options: { replace: boolean }) => void;
}) {
  const t = useT();
  const [ownTab, setOwnTab] = useState<ResearchSubTab>("channels");
  const routed = onTabChange !== undefined;
  const tab = routed ? (routeTab ?? "channels") : ownTab;
  // Read from inside the poll (a new parent function or address never restarts it).
  const onTabChangeRef = useRef(onTabChange);
  const addressNamedTab = useRef(Boolean(routeTab));
  useEffect(() => {
    onTabChangeRef.current = onTabChange;
    if (routeTab) addressNamedTab.current = true;
  }, [onTabChange, routeTab]);
  const setTab = useCallback((next: ResearchSubTab, options: { replace: boolean } = { replace: false }) => {
    if (onTabChangeRef.current) onTabChangeRef.current(next, options);
    else setOwnTab(next);
  }, []);
  const [summary, setSummary] = useState<ResearchSummary | null>(null);
  // BL-140 R3: cross-sub-tab links -- the summary's warning link opens Channels filtered to the channels it counts,
  // and a channel's "Show all in Videos" opens Videos filtered to that channel. A new nonce re-applies the same value.
  const [channelsStatusRequest, setChannelsStatusRequest] = useState<{ status: WatchlistStatusFilter; nonce: number } | null>(null);
  const [discoverStatusRequest, setDiscoverStatusRequest] = useState<{ status: "new"; nonce: number } | null>(null);
  const [videosChannelFilter, setVideosChannelFilter] = useState<{ channelId: string; nonce: number } | null>(null);
  // The first successful summary decides the opening sub-tab once (AC-R1-2): Inbox when something waits, otherwise
  // Channels. Once it has, or once the owner picked a sub-tab themselves, no refresh moves them.
  const openingDecided = useRef(false);

  // The latest callback, read from inside the poll so a new parent function never restarts the interval.
  const onPendingRef = useRef(onPendingChange);
  useEffect(() => {
    onPendingRef.current = onPendingChange;
  }, [onPendingChange]);

  // The poll's own refresh, exposed so a change in a sub-tab (an approval, a new channel) refreshes the line at once.
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

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
        // An address that names a sub-tab is the owner's own pick (AC-R1-2).
        const decided = openingDecided.current || addressNamedTab.current;
        if (shouldOpenInbox({ decided, pending: data.pending.total })) setTab("inbox", { replace: true });
        else if (!decided && onTabChangeRef.current) setTab("channels", { replace: true });
        openingDecided.current = true;
      } catch {
        // Non-fatal: the line keeps its last state until the next poll.
      }
    }
    refreshRef.current = refresh;
    void refresh();
    const id = setInterval(() => void refresh(), SUMMARY_POLL_MS);
    return () => {
      cancelled = true;
      refreshRef.current = null;
      clearInterval(id);
    };
  }, [setTab]);

  // The owner picked a sub-tab (or followed a link): from now on only they move it (AC-R1-2, BL-140 review).
  function pickTab(next: ResearchSubTab) {
    openingDecided.current = true;
    setTab(next);
  }

  const onChanged = useCallback(() => void refreshRef.current?.(), []);

  const pending = summary?.pending.total ?? 0;

  return (
    <div className="space-y-4">
      {summary && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-zinc-400" aria-label={t("research.summary.aria")}>
          {describeResearchSummary(t, summary).map((part) =>
            part.goTo ? (
              <button
                key={part.text}
                type="button"
                onClick={() => {
                  // Each link opens its list showing exactly what it counted, whatever filter was left there.
                  if (part.goTo === "channels") setChannelsStatusRequest({ status: part.filter ?? "", nonce: Date.now() });
                  if (part.goTo === "discover") setDiscoverStatusRequest({ status: "new", nonce: Date.now() });
                  pickTab(part.goTo as ResearchSubTab);
                }}
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

      <div className="inline-flex flex-wrap gap-1 rounded-lg bg-zinc-950 p-1" role="tablist" aria-label={t("research.sections.aria")}>
        {RESEARCH_TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={tab === item.value}
            onClick={() => pickTab(item.value)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${tab === item.value ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            {t(item.labelKey)}
            {item.value === "inbox" && pending > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white">{pending}</span>
            )}
          </button>
        ))}
      </div>

      <div className={tab === "inbox" ? "space-y-6" : "hidden"}>
        <p className="text-sm text-zinc-400">{t("research.inbox.intro")}</p>
        <FeatureErrorBoundary label={t("research.boundary.agentProposals")}>
          <AgentProposalsPanel onChanged={onChanged} />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={t("research.boundary.requests")}>
          <MarketResearchRequestsPanel onChanged={onChanged} />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={t("research.boundary.collectionRequests")}>
          <MarketCollectionRequestsPanel onChanged={onChanged} />
        </FeatureErrorBoundary>
      </div>
      <div className={tab === "channels" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label={t("research.boundary.watchlist")}>
          <MarketResearchPanel
            active={tab === "channels"}
            onChanged={onChanged}
            statusFilterRequest={channelsStatusRequest}
            onShowVideos={(channelId) => {
              setVideosChannelFilter({ channelId, nonce: Date.now() });
              pickTab("videos");
            }}
          />
        </FeatureErrorBoundary>
      </div>
      <div className={tab === "videos" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label={t("research.boundary.videos")}>
          <MarketVideosPanel active={tab === "videos"} channelFilter={videosChannelFilter?.channelId ?? null} channelFilterNonce={videosChannelFilter?.nonce} />
        </FeatureErrorBoundary>
      </div>
      <div className={tab === "discover" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label={t("research.boundary.discovery")}>
          <MarketDiscoveryPanel active={tab === "discover"} onChanged={onChanged} statusFilterRequest={discoverStatusRequest} />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={t("research.boundary.musicChart")}>
          <MusicChartPanel />
        </FeatureErrorBoundary>
      </div>
      <div className={tab === "topics" ? "space-y-6" : "hidden"}>
        {/* Plan §4.6: the two lists side by side, stacked on narrow screens. */}
        <div className="grid items-start gap-6 xl:grid-cols-2">
          <FeatureErrorBoundary label={t("research.boundary.topics")}>
            <MarketTopicsPanel />
          </FeatureErrorBoundary>
          <FeatureErrorBoundary label={t("research.boundary.trends")}>
            <MarketTrendsPanel />
          </FeatureErrorBoundary>
        </div>
      </div>
    </div>
  );
}
