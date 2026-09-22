"use client";

import { useSession, signOut, signIn } from "next-auth/react";
import { redirect } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import type { ComponentType, SVGProps } from "react";
import { AnalyticsManager } from "@/components/analytics-manager";
import { ContentManager } from "@/components/content-manager";
import { LanguagesManager } from "@/components/languages-manager";
import { BatchManager } from "@/components/batch-manager";
import { AiConnectionsManager } from "@/components/ai-connections-manager";
import { AnalyticsSyncSettings } from "@/components/analytics-sync-settings";
import { LiveWritesSettings } from "@/components/live-writes-settings";
import { ReadGatewaySettings } from "@/components/read-gateway-settings";
import { CloudConnectionSettings } from "@/components/cloud-connection-settings";
import { AppVersionInfo } from "@/components/app-version-info";
import { EditorialProfilePanel } from "@/components/editorial-profile-panel";
import { DeviceHandoffPanel } from "@/components/device-handoff-panel";
import { AppShell } from "@/components/app-shell";
import { InfoTooltip } from "@/components/info-tooltip";
import {
  AnalyticsIcon,
  BatchesIcon,
  ContentIcon,
  DeviceIcon,
  HomeIcon,
  LocalizationsIcon,
  SettingsIcon,
} from "@/components/icons";

export type ChannelInfo = {
  id: string;
  title: string;
  thumbnail?: string;
  videoCount?: string;
};

// Tab is derived from NAV_ITEMS (not declared independently) so the two can never drift apart --
// adding a nav entry adds the tab, and vice versa, with no separate list for the compiler to miss.
const NAV_ITEMS = [
  { value: "home", label: "Home", icon: HomeIcon },
  { value: "content", label: "Content", icon: ContentIcon },
  { value: "analytics", label: "Analytics", icon: AnalyticsIcon },
  { value: "languages", label: "Languages", icon: LocalizationsIcon },
  { value: "batches", label: "Batches", icon: BatchesIcon },
  { value: "settings", label: "Settings", icon: SettingsIcon },
  // Renamed from "Device" (2026-09-21, AUTOMERGE_MIGRATION_PLAN.md §6 CD6, owner instruction):
  // this tab is now also where every detected draft-sync conflict is tracked and presented for a
  // human decision, not only device handoff export/import.
  { value: "merge", label: "Merge", icon: DeviceIcon },
] as const satisfies {
  value: string;
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

type Tab = (typeof NAV_ITEMS)[number]["value"];

export default function Dashboard() {
  const { data: session, status } = useSession();
  const [tab, setTab] = useState<Tab>("home");
  const [channel, setChannel] = useState<ChannelInfo | null>(null);
  const [conflictCount, setConflictCount] = useState(0);

  const fetchChannel = useCallback(async () => {
    const res = await fetch("/api/youtube/channel-info");
    const data = await res.json();
    setChannel(data.channel);
  }, []);

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
    fetch(`/api/channels/${encodeURIComponent(channel.id)}/analytics/auto-collect`, { method: "POST" }).catch(() => {
      // Non-fatal -- the staleness check means the next dashboard load simply tries again.
    });
  }, [channel]);

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

  const navItemsWithBadges = NAV_ITEMS.map((item) =>
    item.value === "merge" ? { ...item, badge: conflictCount } : item
  );

  async function handleSwitchChannel() {
    // Found via operator testing feedback: signing out first (the old behavior) cleared the
    // session before signIn's redirect could take over, so the user briefly saw this app's own
    // login screen instead of going straight to Google. The Google provider's own
    // authorization params (src/lib/auth.ts) already carry `prompt: "select_account consent"`,
    // which forces Google to show its account/channel chooser on every signIn call regardless
    // of whether an existing session exists here -- no signOut is needed to get that prompt.
    await signIn("google");
  }

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
      onTabChange={setTab}
      channel={channel}
      userName={session.user?.name}
      onSwitchChannel={handleSwitchChannel}
      onSignOut={() => signOut()}
    >
      {tab === "home" && (
        <div className="max-w-3xl space-y-6">
          <p className="text-sm text-zinc-400">
            Channel dashboard (docs/roadmap/plans/STUDIO_PARITY_PLAN.md Slice S4). Recent-video
            and comment/subscriber cards are planned for a later pass — this tab starts with the
            editorial profile, since it applies everywhere AI localization happens.
          </p>
          <EditorialProfilePanel />
        </div>
      )}

      {tab === "content" && (
        <div>
          <p className="mb-4 text-sm text-zinc-400">
            Your synchronized videos, Studio-style. Read-only: no metadata is written to
            YouTube from this tab.
          </p>
          <ContentManager />
        </div>
      )}

      {tab === "analytics" && (
        <div>
          <p className="mb-4 text-sm text-zinc-400">
            Manual collection for now (BL-059&apos;s daily auto-collection is a separate,
            not-yet-built follow-up) &mdash; facts only, no comparisons or recommendations yet
            (Phase 10&apos;s own scope).
          </p>
          <AnalyticsManager />
        </div>
      )}

      {tab === "languages" && (
        <div>
          <p className="mb-4 text-sm text-zinc-400">
            Generating with AI is the primary way to add a language &mdash; review and edit
            the agent&rsquo;s proposals before creating a Change Set. Importing an edited XLSX
            workbook remains available as a secondary, bulk action. No metadata is written to
            YouTube anywhere in this tab &mdash; approval here is a local decision only, and
            &ldquo;Одобрено&rdquo; never means a real YouTube write happened.
          </p>
          <LanguagesManager />
        </div>
      )}

      {tab === "batches" && (
        <div>
          <p className="mb-4 text-sm text-zinc-400">
            Select approved changes into a Batch and preview it in dry-run mode. A real,
            non-dry-run write is only possible when &ldquo;Live writes&rdquo; is turned on
            in Settings &mdash; off by default every session.
          </p>
          <BatchManager />
        </div>
      )}

      {tab === "settings" && (
        <div className="max-w-3xl space-y-6">
          <AppVersionInfo />
          <LiveWritesSettings />
          <ReadGatewaySettings />
          <CloudConnectionSettings />
          <AnalyticsSyncSettings />
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <h3 className="mb-4 flex items-center gap-1.5 text-base font-semibold text-zinc-100">
              AI provider connections
              <InfoTooltip>
                Configure AI provider connections for AI Localization. No specific vendor is
                built into this app &mdash; every connection is a Base URL, model id, and
                optional credential you supply. Credentials are encrypted at rest and never
                shown again once saved. Testing a connection is an explicit action and may
                incur cost for a real (non-mock) connection.
              </InfoTooltip>
            </h3>
            <AiConnectionsManager />
          </div>
        </div>
      )}

      {tab === "merge" && (
        <div className="max-w-3xl">
          <p className="mb-4 text-sm text-zinc-400">
            Whole-database handoff (export/import) below is still one active device at a time.
            Change drafts (Change Sets/AI proposals) are different: they now sync continuously in
            the background between devices sharing the same Syncthing folder, and any conflicting
            concurrent edit is listed here for you to review &mdash; nothing is ever silently
            resolved by picking one side. Syncthing only ever carries files &mdash; it is never
            treated as a database, and no OAuth token or AI connection credential ever leaves
            this device.
          </p>
          <DeviceHandoffPanel channelId={channel?.id ?? null} />
        </div>
      )}
    </AppShell>
  );
}
