"use client";

import type { PeerReviewSource } from "./plan-review-screen";
import { useCallback, useEffect, useState } from "react";
import type { RunpodAccountBalance } from "@/lib/media-gateway";
import type { MediaSessionLimits } from "@/lib/media-generation/contracts";
import {
  ComputeCard,
  JobsCard,
  CapacityLogCard,
  FactoryLimitsCard,
  GpuFallbackCard,
  LimitsCard,
  ModelsCard,
  ReadinessBanner,
  OtherDevicesCard,
  SessionsCard,
  VolumeCard,
  WorkflowTemplatesCard,
  useMediaOverview,
} from "./media-generation-settings";
import { PlansPanel } from "./generation-plans-panel";

// Phase 14 slice 6 (owner, Telegram 2026-10-05, msg 1549; PHASE_14_PLAN.md §5.2, AC-P14-26): the Production section --
// remote media generation's day-to-day work. Tabs are ordered by how often they are visited: the work tabs on the left
// (Sessions, Jobs, Models, Workflow templates), the setup tab on the right. The header shows the connected RunPod
// account's balance and today's spend. The RunPod keys themselves stay in Settings → RunPod.

export const PRODUCTION_TABS = [
  { value: "sessions", label: "Sessions", side: "work" },
  { value: "jobs", label: "Jobs", side: "work" },
  // BL-143 (ADR 0029, AC-GP-15): generation plans, next to the jobs they are made of.
  { value: "plans", label: "Plans", side: "work" },
  { value: "models", label: "Models", side: "work" },
  { value: "templates", label: "Workflow templates", side: "work" },
  { value: "setup", label: "Setup", side: "setup" },
] as const;
type ProductionTab = (typeof PRODUCTION_TABS)[number]["value"];

/** The balance is a RunPod call: on open, on demand, and once a minute while Production is open. */
const BALANCE_POLL_MS = 60_000;

/** The header line for the balance, in words (exported for its unit test). */
export function describeBalance(balance: RunpodAccountBalance): { headline: string; detail: string | null } {
  if (balance.source === "graphql") {
    const parts = [balance.spendPerHrUsd !== null ? `spending $${balance.spendPerHrUsd.toFixed(3)}/h now` : null, balance.spendLimitUsd !== null ? `account spend limit $${balance.spendLimitUsd.toFixed(2)}/h` : null].filter(Boolean);
    return { headline: `$${balance.balanceUsd.toFixed(2)}`, detail: parts.length > 0 ? parts.join(" · ") : null };
  }
  const window = balance.from && balance.to ? ` (${balance.from.slice(0, 10)} – ${balance.to.slice(0, 10)})` : "";
  return {
    headline: "balance unavailable",
    detail: `RunPod spend${window}: $${balance.spentUsd.toFixed(2)} (pods $${balance.podsUsd.toFixed(2)}, network volumes $${balance.networkVolumesUsd.toFixed(2)}). The balance read failed: ${balance.balanceError}`,
  };
}

function BalanceHeader({ configured, limits, activeElsewhere = 0 }: { configured: boolean; limits: MediaSessionLimits | null; activeElsewhere?: number }) {
  const [balance, setBalance] = useState<RunpodAccountBalance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // State changes only in the promise callbacks (react-hooks/set-state-in-effect); the button sets `loading` itself.
  const fetchBalance = useCallback(() => {
    return fetch("/api/media-generation/balance")
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { balance?: RunpodAccountBalance; message?: string };
        if (!res.ok || !data.balance) throw new Error(data.message ?? `Balance request failed (${res.status})`);
        setBalance(data.balance);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Balance request failed"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!configured) return;
    void fetchBalance();
    const timer = setInterval(() => void fetchBalance(), BALANCE_POLL_MS);
    return () => clearInterval(timer);
  }, [configured, fetchBalance]);

  const described = balance ? describeBalance(balance) : null;
  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <p className="text-xs text-zinc-500">RunPod balance{balance?.source === "graphql" ? " (legacy API)" : ""}</p>
        {!configured ? (
          <p className="text-sm text-zinc-400">Connect RunPod in Settings → RunPod.</p>
        ) : described ? (
          <>
            <p className="text-2xl font-semibold text-zinc-100">{described.headline}</p>
            {described.detail && <p className="max-w-xl text-xs text-zinc-500">{described.detail}</p>}
          </>
        ) : (
          <p className="text-sm text-zinc-500">{error ?? "Loading…"}</p>
        )}
        {described && error && <p className="text-xs text-amber-400">Last refresh failed: {error}</p>}
      </div>
      {limits && (
        <div>
          <p className="text-xs text-zinc-500">Today</p>
          <p className="text-2xl font-semibold text-zinc-100">
            ${limits.spentTodayUsd.toFixed(2)} <span className="text-sm font-normal text-zinc-500">of ${limits.maxUsdPerDay.toFixed(2)}</span>
          </p>
          <p className="text-xs text-zinc-500">
            {limits.activeSessionCount} of {limits.maxConcurrentSessions} sessions active
            {activeElsewhere > 0 ? ` (+${activeElsewhere} on other devices)` : ""} · {limits.openSessions.filter((s) => s.status === "pending").length} waiting for approval
          </p>
        </div>
      )}
      {configured && (
        <button type="button" onClick={() => {
            setLoading(true);
            void fetchBalance();
          }}
          disabled={loading} className="ml-auto rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50">
          {loading ? "Refreshing…" : "Refresh balance"}
        </button>
      )}
    </div>
  );
}

export function ProductionPanel({
  activeChannelId = null,
  tab: routeTab,
  onTabChange,
  onReviewPlan,
}: {
  activeChannelId?: string | null;
  /** BL-149: the sub-tab from the address (`/production/<tab>`), with navigation on a click; absent = local state. */
  tab?: ProductionTab;
  onTabChange?: (tab: ProductionTab) => void;
  /** BL-149: where the review screen of a plan opens (its own address); absent = in place. */
  onReviewPlan?: (planId: string, source?: PeerReviewSource) => void;
}) {
  const [ownTab, setOwnTab] = useState<ProductionTab>("sessions");
  const tab = routeTab ?? ownTab;
  const setTab = onTabChange ?? setOwnTab;
  const [limits, setLimits] = useState<MediaSessionLimits | null>(null);
  const [activeElsewhere, setActiveElsewhere] = useState(0);
  const { overview, loadError, gatewayTraffic, refresh } = useMediaOverview();

  if (loadError) return <p className="text-sm text-red-400">{loadError}</p>;
  if (!overview) return <p className="text-sm text-zinc-500">Loading…</p>;

  const tabButton = (t: (typeof PRODUCTION_TABS)[number]) => (
    <button
      key={t.value}
      type="button"
      onClick={() => setTab(t.value)}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${tab === t.value ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
    >
      {t.label}
    </button>
  );

  // Every tab stays mounted and is only hidden (like Settings' sub-tabs): Sessions keeps polling -- the header's counts
  // and an agent's new request stay current whichever tab is open.
  return (
    <div className="max-w-5xl space-y-6">
      <BalanceHeader configured={overview.credentials.configured} limits={limits} activeElsewhere={activeElsewhere} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap gap-1 rounded-lg bg-zinc-950 p-1">{PRODUCTION_TABS.filter((t) => t.side === "work").map(tabButton)}</div>
        <div className="ml-auto inline-flex gap-1 rounded-lg bg-zinc-950 p-1">{PRODUCTION_TABS.filter((t) => t.side === "setup").map(tabButton)}</div>
      </div>
      <div className={tab === "sessions" ? "space-y-6" : "hidden"}>
        <SessionsCard ready={overview.ready} activeChannelId={activeChannelId} onLimits={setLimits} />
        <OtherDevicesCard ready={overview.credentials.configured} onActiveElsewhere={setActiveElsewhere} />
      </div>
      <div className={tab === "jobs" ? "space-y-6" : "hidden"}>
        <JobsCard activeChannelId={activeChannelId} />
      </div>
      <div className={tab === "plans" ? "space-y-6" : "hidden"}>
        <PlansPanel active={tab === "plans"} onReview={onReviewPlan} />
      </div>
      <div className={tab === "models" ? "space-y-6" : "hidden"}>
        <ModelsCard configured={overview.credentials.configured && Boolean(overview.settings.networkVolumeId)} active={tab === "models"} />
      </div>
      <div className={tab === "templates" ? "space-y-6" : "hidden"}>
        <WorkflowTemplatesCard />
      </div>
      <div className={tab === "setup" ? "max-w-3xl space-y-6" : "hidden"}>
        <ReadinessBanner overview={overview} />
        <ComputeCard overview={overview} gatewayTraffic={gatewayTraffic} onChanged={refresh} />
        <VolumeCard overview={overview} onChanged={refresh} />
        <LimitsCard settings={overview.settings} onChanged={refresh} />
        <GpuFallbackCard settings={overview.settings} onChanged={refresh} />
        <FactoryLimitsCard settings={overview.settings} onChanged={refresh} />
        <CapacityLogCard />
      </div>
    </div>
  );
}
