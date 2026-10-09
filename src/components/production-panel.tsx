"use client";

import { formatDisplayDateUtc } from "@/lib/shared-formatting";
import { errorText } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";
import type { Translate, UiTextKey } from "@/lib/ui-text";
import type { PeerReviewSource } from "./plan-review-screen";
import { SettingsSyncNotice } from "./settings-sync-notice";
import { useCallback, useEffect, useState } from "react";
import type { RunpodAccountBalance } from "@/lib/media-gateway";
import type { MediaSessionLimits } from "@/lib/media-generation/contracts";
import {
  ComputeCard,
  JobsCard,
  CapacityLogCard,
  NowRunningLine,
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

// Phase 14 slice 6 (owner, Telegram 2026-10-05, msg 1549; PHASE_14_PLAN.md §5.2, AC-P14-26): remote media generation's
// day-to-day work, the setup tab on the right. BL-157 (SERVERS_MEDIA_PLAN.md, FO-REQ-0009): split into Servers (shared) and
// Media (the active channel's). The Servers header shows the RunPod balance and today's spend; the keys stay in Settings.

import { MEDIA_TABS, SERVERS_TABS, type MediaTab, type ServersTab } from "./section-tabs";
export { MEDIA_TABS, SERVERS_TABS };

/** The balance is a RunPod call: on open, on demand, and once a minute while Production is open. */
const BALANCE_POLL_MS = 60_000;

/** The header line for the balance, in words (exported for its unit test). */
export function describeBalance(t: Translate, balance: RunpodAccountBalance): { headline: string; detail: string | null } {
  if (balance.source === "graphql") {
    const parts = [balance.spendPerHrUsd !== null ? t("production.balance.spendingNow", { rate: balance.spendPerHrUsd.toFixed(3) }) : null, balance.spendLimitUsd !== null ? t("production.balance.spendLimit", { limit: balance.spendLimitUsd.toFixed(2) }) : null].filter(Boolean);
    return { headline: t("unit.usd", { value: balance.balanceUsd.toFixed(2) }), detail: parts.length > 0 ? parts.join(" · ") : null };
  }
  const amounts = { spent: balance.spentUsd.toFixed(2), pods: balance.podsUsd.toFixed(2), volumes: balance.networkVolumesUsd.toFixed(2), error: balance.balanceError };
  return {
    headline: t("production.balance.unavailable"),
    detail:
      balance.from && balance.to
        ? t("production.balance.billingWindow", { ...amounts, from: formatDisplayDateUtc(balance.from), to: formatDisplayDateUtc(balance.to) })
        : t("production.balance.billing", amounts),
  };
}

function BalanceHeader({ configured, limits, activeElsewhere = 0 }: { configured: boolean; limits: MediaSessionLimits | null; activeElsewhere?: number }) {
  const t = useT();
  const [balance, setBalance] = useState<RunpodAccountBalance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // State changes only in the promise callbacks (react-hooks/set-state-in-effect); the button sets `loading` itself.
  const fetchBalance = useCallback(() => {
    return fetch("/api/media-generation/balance")
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { balance?: RunpodAccountBalance; message?: string };
        if (!res.ok || !data.balance) throw new Error(errorText(t, data, t("production.balance.requestFailedStatus", { status: String(res.status) }), { showErrorField: false }));
        setBalance(data.balance);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("production.balance.requestFailed")))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    if (!configured) return;
    void fetchBalance();
    const timer = setInterval(() => void fetchBalance(), BALANCE_POLL_MS);
    return () => clearInterval(timer);
  }, [configured, fetchBalance]);

  const described = balance ? describeBalance(t, balance) : null;
  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <p className="text-xs text-zinc-500">{balance?.source === "graphql" ? t("production.balance.titleLegacy") : t("production.balance.title")}</p>
        {!configured ? (
          <p className="text-sm text-zinc-400">{t("production.balance.connect")}</p>
        ) : described ? (
          <>
            <p className="text-2xl font-semibold text-zinc-100">{described.headline}</p>
            {described.detail && <p className="max-w-xl text-xs text-zinc-500">{described.detail}</p>}
          </>
        ) : (
          <p className="text-sm text-zinc-500">{error ?? t("common.loading")}</p>
        )}
        {described && error && <p className="text-xs text-amber-400">{t("production.balance.lastRefreshFailed", { error })}</p>}
      </div>
      {limits && (
        <div>
          <p className="text-xs text-zinc-500">{t("production.today")}</p>
          <p className="text-2xl font-semibold text-zinc-100">
            {t("unit.usd", { value: limits.spentTodayUsd.toFixed(2) })} <span className="text-sm font-normal text-zinc-500">{t("production.todayOf", { max: limits.maxUsdPerDay.toFixed(2) })}</span>
          </p>
          <p className="text-xs text-zinc-500">
            {activeElsewhere > 0
              ? t("production.sessionsActiveElsewhere", { active: limits.activeSessionCount, max: limits.maxConcurrentSessions, elsewhere: activeElsewhere })
              : t("production.sessionsActive", { active: limits.activeSessionCount, max: limits.maxConcurrentSessions })}{" "}
            · {t("production.waitingApproval", { count: limits.openSessions.filter((s) => s.status === "pending").length })}
          </p>
        </div>
      )}
      {configured && (
        <button type="button" onClick={() => {
            setLoading(true);
            void fetchBalance();
          }}
          disabled={loading} className="ml-auto rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50">
          {loading ? t("production.balance.refreshing") : t("production.balance.refresh")}
        </button>
      )}
    </div>
  );
}

/** The tab bar of a section: work tabs on the left, a setup tab (if any) on the right. */
function TabBar<V extends string>({ tabs, current, onSelect }: { tabs: ReadonlyArray<{ value: V; labelKey: UiTextKey; side?: "work" | "setup" }>; current: V; onSelect: (tab: V) => void }) {
  const t = useT();
  const button = (item: (typeof tabs)[number]) => (
    <button
      key={item.value}
      type="button"
      onClick={() => onSelect(item.value)}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${current === item.value ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
    >
      {t(item.labelKey)}
    </button>
  );
  const setup = tabs.filter((item) => item.side === "setup");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex flex-wrap gap-1 rounded-lg bg-zinc-950 p-1">{tabs.filter((item) => item.side !== "setup").map(button)}</div>
      {setup.length > 0 && <div className="ml-auto inline-flex gap-1 rounded-lg bg-zinc-950 p-1">{setup.map(button)}</div>}
    </div>
  );
}

/**
 * BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-01, FO-REQ-0009 §1): Servers -- the shared GPU and model infrastructure, the same for
 * every channel: the balance, sessions of every channel (and of the other devices), models, templates and the setup with
 * storage, limits and the capacity log.
 */
export function ServersPanel({
  activeChannelId = null,
  tab: routeTab,
  onTabChange,
}: {
  activeChannelId?: string | null;
  /** The sub-tab from the address (`/servers/<tab>`), with navigation on a click; absent = local state. */
  tab?: ServersTab;
  onTabChange?: (tab: ServersTab) => void;
}) {
  const t = useT();
  const [ownTab, setOwnTab] = useState<ServersTab>("sessions");
  const tab = routeTab ?? ownTab;
  const setTab = onTabChange ?? setOwnTab;
  const [limits, setLimits] = useState<MediaSessionLimits | null>(null);
  const [activeElsewhere, setActiveElsewhere] = useState(0);
  const { overview, loadError, gatewayTraffic, refresh } = useMediaOverview();

  if (loadError) return <p className="text-sm text-red-400">{loadError}</p>;
  if (!overview) return <p className="text-sm text-zinc-500">{t("common.loading")}</p>;

  // Every tab stays mounted and is only hidden (like Settings' sub-tabs): Sessions keeps polling -- the header's counts
  // and an agent's new request stay current whichever tab is open.
  return (
    <div className="max-w-5xl space-y-6">
      <BalanceHeader configured={overview.credentials.configured} limits={limits} activeElsewhere={activeElsewhere} />
      <TabBar tabs={SERVERS_TABS} current={tab} onSelect={setTab} />
      <div className={tab === "sessions" ? "space-y-6" : "hidden"}>
        <SessionsCard ready={overview.ready} activeChannelId={activeChannelId} onLimits={setLimits} />
        <OtherDevicesCard ready={overview.credentials.configured} onActiveElsewhere={setActiveElsewhere} />
      </div>
      <div className={tab === "models" ? "space-y-6" : "hidden"}>
        <ModelsCard configured={overview.credentials.configured && Boolean(overview.settings.networkVolumeId)} active={tab === "models"} />
      </div>
      <div className={tab === "templates" ? "space-y-6" : "hidden"}>
        <WorkflowTemplatesCard />
      </div>
      <div className={tab === "setup" ? "max-w-3xl space-y-6" : "hidden"}>
        <SettingsSyncNotice onApplied={() => void refresh()} />
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

/**
 * BL-157 (AC-SM-01/03/06, FO-REQ-0009 §2): Media -- what the owner reviews for the ACTIVE channel: its plans (with the
 * review) and its jobs, plus a line while a session of this channel generates. The routes behind it return only the active
 * channel's plans and jobs; the section remounts when the channel changes.
 */
export function MediaPanel({
  activeChannelId = null,
  tab: routeTab,
  onTabChange,
  onReviewPlan,
  paused = false,
  sessionsHref = "/servers/sessions",
}: {
  activeChannelId?: string | null;
  /** The sub-tab from the address (`/media/<tab>`), with navigation on a click; absent = local state. */
  tab?: MediaTab;
  onTabChange?: (tab: MediaTab) => void;
  /** BL-149 re-review: the panel is hidden behind a plan review; Plans stops polling meanwhile. */
  paused?: boolean;
  /** BL-149: where the review screen of a plan opens (its own address); absent = in place. BL-162: `wave` = open on that wave. */
  onReviewPlan?: (planId: string, source?: PeerReviewSource, wave?: string) => void;
  /** Where "now running" leads: Servers → Sessions. */
  sessionsHref?: string;
}) {
  const [ownTab, setOwnTab] = useState<MediaTab>("plans");
  const tab = routeTab ?? ownTab;
  const setTab = onTabChange ?? setOwnTab;
  return (
    <div className="max-w-5xl space-y-6">
      <NowRunningLine activeChannelId={activeChannelId} sessionsHref={sessionsHref} />
      <TabBar tabs={MEDIA_TABS} current={tab} onSelect={setTab} />
      <div className={tab === "plans" ? "space-y-6" : "hidden"}>
        <PlansPanel active={tab === "plans" && !paused} onReview={onReviewPlan} />
      </div>
      <div className={tab === "jobs" ? "space-y-6" : "hidden"}>
        <JobsCard activeChannelId={activeChannelId} />
      </div>
    </div>
  );
}
