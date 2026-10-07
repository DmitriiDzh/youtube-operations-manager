"use client";

import { useState } from "react";
import { AnalyticsManager } from "./analytics-manager";
import { ChannelOverviewPanel } from "./channel-overview-panel";
import { ContentAnalyticsPanel } from "./content-analytics-panel";
import { AudienceAnalyticsPanel } from "./audience-analytics-panel";

import { ANALYTICS_SUB_TABS, type AnalyticsSubTab } from "./section-tabs";
export { ANALYTICS_SUB_TABS, type AnalyticsSubTab };
const SUB_TABS = ANALYTICS_SUB_TABS;
type SubTabKey = AnalyticsSubTab;

/**
 * Composes the Studio-Parity Overview/Content/Audience sub-tabs
 * (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md) -- matching real Studio's own top-tab
 * strip (Trends deliberately excluded, per the owner's own scope). Each sub-tab is a separate
 * component so switching never re-fetches or re-renders the other two (matches this app's existing
 * conditional-rendering tab pattern elsewhere, e.g. the dashboard's own top-level tabs) --
 * preserves the pre-existing raw-collected-data view (`AnalyticsManager`, Phase 8/BL-058)
 * unchanged (AGENTS.md §D), still reachable from Overview's own disclosure toggle.
 */
export function AnalyticsTab({
  subscriberCount,
  tab,
  onTabChange,
}: {
  subscriberCount?: string;
  /** BL-149: the sub-tab from the address (`/analytics/<tab>`), with navigation on a click; absent = local state. */
  tab?: SubTabKey;
  onTabChange?: (tab: SubTabKey) => void;
}) {
  const [ownSubTab, setOwnSubTab] = useState<SubTabKey>("overview");
  const activeSubTab = tab ?? ownSubTab;
  const setActiveSubTab = onTabChange ?? setOwnSubTab;
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b border-zinc-800">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveSubTab(tab.key)}
            className={`px-3 py-2 text-sm font-medium transition-colors ${
              activeSubTab === tab.key
                ? "border-b-2 border-indigo-500 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeSubTab === "overview" && (
        <>
          <ChannelOverviewPanel subscriberCount={subscriberCount} />

          <div className="border-t border-zinc-800 pt-4">
            <button
              onClick={() => setShowRaw((v) => !v)}
              className="text-sm font-medium text-zinc-400 hover:text-zinc-200"
            >
              {showRaw ? "Hide" : "Show"} raw collected data
            </button>
            {showRaw && (
              <div className="mt-4">
                <AnalyticsManager />
              </div>
            )}
          </div>
        </>
      )}

      {activeSubTab === "content" && <ContentAnalyticsPanel />}
      {activeSubTab === "audience" && <AudienceAnalyticsPanel />}
    </div>
  );
}
