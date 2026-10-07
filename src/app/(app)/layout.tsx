"use client";

import { useSession, signOut } from "next-auth/react";
import { redirect, usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { ConnectionHealthDialog } from "@/components/connection-health-dialog";
import { useConnectionHealth } from "@/components/use-connection-health";
import { AppShell } from "@/components/app-shell";
import { OperationLockControl } from "@/components/operation-lock-control";
import { AppChannelProvider, type ChannelInfo } from "@/components/app-channel";
import { rememberablePath, sectionHref } from "@/components/section-tabs";
import { LoadingOverlay } from "@/components/loading-overlay";
import { ConflictCenter, useConflictCenter } from "@/components/conflict-center";
import {
  INITIAL_STARTUP,
  STARTUP_STEPS,
  analyticsOutcome,
  channelUnavailable as startupWithoutChannel,
  reachOutcome,
  researchOutcome,
  startupInProgress,
  type StartupProgress,
  type StartupStepKey,
  type StepStatus,
} from "@/components/startup-progress";
import { CHANNEL_SWITCH_EVENT, type ChannelSwitchEventDetail } from "@/components/use-connected-channels";
import {
  AnalyticsIcon,
  BatchesIcon,
  ContentIcon,
  ProductionIcon,
  DecisionsIcon,
  DeviceIcon,
  HomeIcon,
  LocalizationsIcon,
  ResearchIcon,
  SettingsIcon,
} from "@/components/icons";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): everything of the former single dashboard page that is not a section --
// the shell, the active channel, the connection-health dialog, the operation-lock control and every background poll. A
// layout persists across navigations, so these run once per app load, exactly as before; each section is its own page.

// Tab is derived from NAV_ITEMS (not declared independently) so the two can never drift apart --
// adding a nav entry adds the tab, and vice versa, with no separate list for the compiler to miss.
const NAV_ITEMS = [
  { value: "home", href: "/home", label: "Home", icon: HomeIcon },
  { value: "content", href: "/content", label: "Content", icon: ContentIcon },
  // Phase 14 slice 6 (owner, Telegram 2026-10-05, msg 1549): remote media generation -- sessions, jobs, models,
  // workflow templates and their setup -- right after Content. The RunPod keys stay in Settings → RunPod.
  { value: "production", href: "/production", label: "Production", icon: ProductionIcon },
  { value: "analytics", href: "/analytics", label: "Analytics", icon: AnalyticsIcon },
  { value: "languages", href: "/languages", label: "Languages", icon: LocalizationsIcon },
  { value: "batches", href: "/batches", label: "Batches", icon: BatchesIcon },
  // Phase 9 slice 2 (docs/roadmap/plans/PHASE_9_PLAN.md) -- global, not channel-scoped (see
  // MarketResearchPanel's own doc comment), so it doesn't need `channel` the way Content/
  // Analytics/Languages/Batches do.
  { value: "research", href: "/research", label: "Research", icon: ResearchIcon },
  // Phase 10 slice 1 (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md) -- global, not channel-scoped
  // as a tab, though an individual hypothesis may itself be channel-scoped (see DecisionsManager).
  { value: "decisions", href: "/decisions", label: "Decisions", icon: DecisionsIcon },
  { value: "settings", href: "/settings", label: "Settings", icon: SettingsIcon },
  // Renamed from "Device" (2026-09-21, AUTOMERGE_MIGRATION_PLAN.md §6 CD6, owner instruction):
  // this tab is now also where every detected draft-sync conflict is tracked and presented for a
  // human decision, not only device handoff export/import.
  { value: "merge", href: "/merge", label: "Merge", icon: DeviceIcon },
] as const satisfies {
  value: string;
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}[];

// Polling intervals for CD5's background sync (AUTOMERGE_MIGRATION_PLAN.md §6, AC-CRDT-07/08).
// Deliberately two different endpoints/intervals, not one (advisor review): the conflict-count
// badge needs to feel current (AC-CRDT-08, "accurate at all times a value is displayed") without
// paying for a real write cycle on every poll, while the actual push/merge sync cycle
// (POST .../sync, a real write to this device's local files) runs less often -- both independent
// of which tab is open, so a conflict introduced by another device is detected even if the
// operator never opens the Merge tab (AC-CRDT-07). The server-side single-flight guard
// (change-drafts-sync/services.ts) makes running the write cycle safe even with multiple tabs
// open, but polling it as rarely as correctness allows is still the cheaper default.
const CONFLICT_SUMMARY_POLL_MS = 20_000;
const SYNC_CYCLE_POLL_MS = 60_000;
// BL-140 R1: how often the sidebar re-reads the pending agent requests in Research (a local read).
const RESEARCH_PENDING_POLL_MS = 60_000;
// BL-143 phase 3 (AC-GP3-02): how often the sidebar re-reads the generation plan attempts waiting for the owner (a local read).
const PLANS_REVIEW_POLL_MS = 60_000;

type Tab = (typeof NAV_ITEMS)[number]["value"];

export default function AppLayout({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  // The section is the first path segment (`/production/plans` → production).
  const pathname = usePathname();
  const tab: Tab | null = NAV_ITEMS.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))?.value ?? null;
  // Review finding: each sidebar item leads back to the sub-tab last open in its section (this app load only).
  const [lastPathBySection, setLastPathBySection] = useState<Record<string, string>>({});
  useEffect(() => {
    const remembered = rememberablePath(pathname);
    if (!remembered) return;
    const { section, path } = remembered;
    queueMicrotask(() => setLastPathBySection((prev) => (prev[section] === path ? prev : { ...prev, [section]: path })));
  }, [pathname]);
  const [channel, setChannel] = useState<ChannelInfo | null>(null);
  // BL-115: the channel request failed (typically a stale Google sign-in) -- say so, don't spin on "Loading..." forever.
  const [channelUnavailable, setChannelUnavailable] = useState(false);
  const connectionHealth = useConnectionHealth(Boolean(session));
  const refetchConnectionHealth = connectionHealth.refetch;
  const [conflictCount, setConflictCount] = useState(0);
  // BL-140 R1: agents' requests waiting in Research → Inbox, shown on the sidebar like Merge's conflicts.
  const [researchPending, setResearchPending] = useState(0);
  const [plansWaiting, setPlansWaiting] = useState(0);
  // Owner, msg 2004: a blurred loading window while the app loads its data on open and while the channel switches.
  const [startup, setStartup] = useState<StartupProgress>(INITIAL_STARTUP);
  const [startupDismissed, setStartupDismissed] = useState(false);
  const setStep = useCallback((key: StartupStepKey, status: StepStatus) => setStartup((prev) => ({ ...prev, [key]: status })), []);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  const fetchChannel = useCallback(async () => {
    try {
      const res = await fetch("/api/youtube/channel-info");
      if (!res.ok) {
        setChannelUnavailable(true);
        setStartup((prev) => (prev.channel.state === "running" ? startupWithoutChannel(prev) : prev));
        // Re-check the stored grants for real now (bypassing the short cache): the popup names which account to sign in with.
        void refetchConnectionHealth({ force: true });
        return;
      }
      const data = await res.json();
      setChannelUnavailable(false);
      setChannel(data.channel);
      setStartup((prev) => (prev.channel.state === "running" ? { ...prev, channel: { state: "done", detail: data.channel?.title ?? null } } : prev));
    } catch {
      // Non-fatal -- can genuinely fail transiently right as the session cookie is swapping (e.g.
      // right after activating a different stored channel connection, docs/decisions/0010), since
      // that no longer reloads the page the way the old signIn("google")-only flow always did.
      // This effect re-runs the moment `session` settles on its new value, so it self-heals.
    }
  }, [refetchConnectionHealth]);

  useEffect(() => {
    if (session) {
      queueMicrotask(() => {
        void fetchChannel();
      });
    }
  }, [session, fetchChannel]);

  // Phase 8 (BL-059, docs/roadmap/plans/PHASE_8_PLAN.md §10 items 3-5): "при входе в дашборд"
  // (on entering the dashboard) -- a mount-once check, not a repeating interval like the Merge
  // tab's polls above (this is a once-a-day rule, not a continuous one). The server itself
  // decides whether anything actually runs (`runAutoCollectionIfStale`'s own staleness check) --
  // this effect only ever fires the request once per dashboard session, regardless of how many
  // times `channel` updates (e.g. after a re-sync), via the ref guard.
  const autoCollectTriggeredRef = useRef(false);
  useEffect(() => {
    if (!channel?.id || autoCollectTriggeredRef.current) return;
    autoCollectTriggeredRef.current = true;
    // BL-142 (owner, Telegram 2026-10-06): one call collects EVERY connected channel (each with its own token; the
    // active one with this session's), and per channel runs the weekly report right after its collection, so a Monday
    // load's weekly snapshot sees that load's own data (advisor review, 2026-09-23; src/lib/analytics/weekly-report.ts).
    // Waits for `channel`, so the session's active channel is already recorded.
    setStep("analytics", { state: "running", detail: null });
    fetch("/api/analytics/auto-collect-all", { method: "POST" })
      .then(
        async (res) => setStep("analytics", analyticsOutcome(res.ok, await res.json().catch(() => null))),
        // Non-fatal -- the staleness check means the next dashboard load simply tries again.
        () => setStep("analytics", { state: "failed", detail: null })
      )
      .finally(() => {
        // Phase 9 slice 9B (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md §7) -- chained after the Analytics collection
        // (never in parallel, same rationale). Channel-agnostic (market intelligence's own watchlist is global) -- the
        // server's own budget/staleness checks decide whether anything actually runs.
        setStep("research", { state: "running", detail: null });
        fetch("/api/market-intelligence/collect-if-stale", { method: "POST" }).then(
          async (res) => setStep("research", researchOutcome(res.ok, await res.json().catch(() => null))),
          // Non-fatal -- the staleness/budget check means the next dashboard load simply tries again.
          () => setStep("research", { state: "failed", detail: null })
        );
      });
  }, [channel, setStep]);


  const refreshConflictSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/change-drafts/conflicts-summary");
      if (!res.ok) return;
      const data = (await res.json()) as { totalConflicts: number };
      setConflictCount(data.totalConflicts);
    } catch {
      // Non-fatal -- the badge just stays at its last known value until the next poll succeeds.
    }
  }, []);

  // Depend on the stable user id, not the `session` object itself (advisor review): NextAuth
  // refetches the session on window focus by default, handing back a new object identity each
  // time even when nothing meaningful changed -- depending on `session` directly would tear down
  // and recreate both intervals (firing an immediate extra sync cycle) every time the operator
  // merely switches back to this browser tab, silently defeating the 60s pacing chosen below.
  const userId = session?.user?.id;

  // BL-114 (docs/decisions/0014-youtube-reporting-api-gateway-child.md) -- the Reporting API's Reach report
  // (impressions/CTR). Its own independent fire-and-forget call, deliberately NOT chained to the Analytics
  // auto-collection (AGENTS.md §M: one module failing or being switched off must not affect another). BL-141 (owner,
  // Telegram 2026-10-06): once per dashboard load it checks EVERY connected channel, each with its own token, not only
  // the active one. The server decides whether anything runs: `onlyIfDue` makes it a no-op for a channel checked
  // within the last 6 hours. It waits for `channel` (GET /api/youtube/channel-info records the session's active
  // channel), so on a fresh sign-in or right after switching, the active channel is already the one being synced.
  const reachSyncTriggeredRef = useRef(false);
  useEffect(() => {
    if (!channel?.id || reachSyncTriggeredRef.current) return;
    reachSyncTriggeredRef.current = true;
    setStep("reach", { state: "running", detail: null });
    fetch("/api/reach/sync-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onlyIfDue: true }),
    }).then(
      (res) => setStep("reach", reachOutcome(res.ok)),
      // Non-fatal -- the next dashboard load simply tries again.
      () => setStep("reach", reachOutcome(false))
    );
  }, [channel, setStep]);

  // A channel switch (topbar or Settings → Channels): the loading window until the new channel has been read.
  useEffect(() => {
    function onSwitch(event: Event) {
      const detail = (event as CustomEvent<ChannelSwitchEventDetail>).detail;
      setSwitchingTo(detail.phase === "start" ? detail.channelId : detail.phase === "failed" ? null : (current) => current);
    }
    window.addEventListener(CHANNEL_SWITCH_EVENT, onSwitch);
    return () => window.removeEventListener(CHANNEL_SWITCH_EVENT, onSwitch);
  }, []);
  useEffect(() => {
    if (!switchingTo) return;
    // Safety net: never keep the screen blurred if the new channel never arrives.
    const timer = setTimeout(() => setSwitchingTo(null), 30_000);
    return () => clearTimeout(timer);
  }, [switchingTo]);
  const switching = switchingTo !== null && channel?.id !== switchingTo;

  // Owner, msgs 2011/2013: once the startup work is done, every difference between the two computers is decided before the
  // app opens (the browser waits; the server, syncing and the operator do not). Re-read every few seconds while it is shown.
  const startupDone = !startupInProgress(startup) || startupDismissed;
  const conflicts = useConflictCenter(Boolean(userId) && startupDone);
  const conflictsBlocking = conflicts.loaded && conflicts.total > 0;
  const refreshConflictCenter = conflicts.refresh;
  useEffect(() => {
    if (!conflictsBlocking) return;
    const id = setInterval(() => void refreshConflictCenter(), 5_000);
    return () => clearInterval(id);
  }, [conflictsBlocking, refreshConflictCenter]);

  // Cheap, read-only conflict-count poll -- runs regardless of which tab is active, so the
  // sidebar badge (AC-CRDT-08) stays current even while the operator is on an unrelated tab.
  useEffect(() => {
    if (!userId) return;
    void refreshConflictSummary();
    const id = setInterval(() => void refreshConflictSummary(), CONFLICT_SUMMARY_POLL_MS);
    return () => clearInterval(id);
  }, [userId, refreshConflictSummary]);

  // The actual background push+merge sync cycle (a real write to this device's local files) --
  // runs on its own, longer interval, independent of the Merge tab (AC-CRDT-07: a conflict
  // introduced by this background loop must be detected without requiring the operator to open
  // that tab). Safe against overlapping browser tabs/polls via the server-side single-flight
  // guard (change-drafts-sync/services.ts), not by anything client-side.
  useEffect(() => {
    if (!userId) return;
    async function runSyncCycle() {
      try {
        await fetch("/api/change-drafts/sync", { method: "POST" });
      } catch {
        // Non-fatal -- the next scheduled cycle (or an explicit "Sync now" in the Merge tab)
        // will simply try again.
      } finally {
        void refreshConflictSummary();
      }
    }
    void runSyncCycle();
    const id = setInterval(() => void runSyncCycle(), SYNC_CYCLE_POLL_MS);
    return () => clearInterval(id);
  }, [userId, refreshConflictSummary]);

  // BL-140 R1 (AC-R1-2): the sidebar shows the pending agent requests whichever tab is open. A local read, no YouTube call.
  useEffect(() => {
    if (!userId) return;
    async function refreshResearchPending() {
      try {
        const res = await fetch("/api/market-intelligence/summary");
        if (!res.ok) return;
        const data = (await res.json()) as { pending?: { total?: number } };
        setResearchPending(data.pending?.total ?? 0);
      } catch {
        // Non-fatal -- the next poll tries again.
      }
    }
    void refreshResearchPending();
    const id = setInterval(() => void refreshResearchPending(), RESEARCH_PENDING_POLL_MS);
    return () => clearInterval(id);
  }, [userId]);

  // BL-143 phase 3 (AC-GP3-02): Production shows how many generated tracks wait for the owner's verdict.
  useEffect(() => {
    if (!userId) return;
    async function refreshPlansWaiting() {
      try {
        const res = await fetch("/api/generation-plans/summary");
        if (!res.ok) return;
        const data = (await res.json()) as { waitingReview?: number };
        setPlansWaiting(data.waitingReview ?? 0);
      } catch {
        // Non-fatal -- the next poll tries again.
      }
    }
    void refreshPlansWaiting();
    const id = setInterval(() => void refreshPlansWaiting(), PLANS_REVIEW_POLL_MS);
    return () => clearInterval(id);
  }, [userId]);

  // With agent requests waiting, Research leads to plain `/research`, where its first-open rule opens Inbox (AC-R1-2),
  // as every visit did before BL-149 (re-review).
  const navItemsWithBadges = NAV_ITEMS.map((item) => ({ ...item, href: item.value === "research" && researchPending > 0 ? item.href : sectionHref(item.href, lastPathBySection) })).map((item) =>
    item.value === "merge" ? { ...item, badge: conflictCount } : item.value === "research" ? { ...item, badge: researchPending } : item.value === "production" ? { ...item, badge: plansWaiting } : item
  );

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-zinc-500">Loading...</p>
      </div>
    );
  }

  if (!session) {
    redirect("/");
  }

  return (
    <AppShell
      navItems={navItemsWithBadges}
      activeTab={tab}
      onReviewDeviceSyncDivergence={() => router.push("/merge")}
      channel={channel}
      channelUnavailable={channelUnavailable}
      onSignOut={() => signOut()}
    >
      <ConnectionHealthDialog health={connectionHealth.health} />
      {startupInProgress(startup) && !startupDismissed && (
        <LoadingOverlay
          title="Loading your data…"
          steps={STARTUP_STEPS.map((step) => ({ ...step, status: startup[step.key] }))}
          onDismiss={() => setStartupDismissed(true)}
        />
      )}
      {conflictsBlocking && (
        <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-zinc-950/40 py-10 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Choose what to keep">
          <div className="w-[56rem] max-w-[94vw] rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
            <ConflictCenter state={conflicts} blocking />
          </div>
        </div>
      )}
      {switching && !conflictsBlocking && (!startupInProgress(startup) || startupDismissed) && (
        <LoadingOverlay
          title="Switching channel…"
          steps={[{ key: "switch", label: "Loading the channel's data", status: { state: "running", detail: null } }]}
          onDismiss={() => setSwitchingTo(null)}
        />
      )}
      {/* Visible on every page, only while a migration/import holds (or left behind) the device lock. */}
      <OperationLockControl quiet />
      <AppChannelProvider value={{ channel, channelUnavailable, setResearchPending }}>{children}</AppChannelProvider>
    </AppShell>
  );
}
