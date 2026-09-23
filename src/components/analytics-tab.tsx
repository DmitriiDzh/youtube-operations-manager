"use client";

import { useState } from "react";
import { AnalyticsManager } from "./analytics-manager";
import { ChannelOverviewPanel } from "./channel-overview-panel";

/**
 * Composes the new Studio-Parity "Overview" panel (docs/roadmap/plans/STUDIO_PARITY_PLAN.md §4,
 * S6b) with the pre-existing raw-collected-data view (`AnalyticsManager`, Phase 8/BL-058) --
 * preserving that working component unchanged (AGENTS.md §D) rather than folding its
 * date-range/"Collect now"/table UI into the new panel. The raw table stays available behind a
 * disclosure toggle, both because it is still how an operator actually populates the local data
 * "Top content" reads from, and as the dataviz skill's required table-view fallback for the new
 * chart.
 */
export function AnalyticsTab({ subscriberCount }: { subscriberCount?: string }) {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="space-y-6">
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
    </div>
  );
}
