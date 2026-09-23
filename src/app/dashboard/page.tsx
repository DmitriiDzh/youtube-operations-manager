"use client";

import { useSession, signOut } from "next-auth/react";
import { redirect } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import type { ComponentType, SVGProps } from "react";
import { AnalyticsManager } from "@/components/analytics-manager";
import { ContentManager } from "@/components/content-manager";
import { LanguagesManager } from "@/components/languages-manager";
import { BatchManager } from "@/components/batch-manager";
import { AiConnectionsManager } from "@/components/ai-connections-manager";
import { AnalyticsCollectionSettings } from "@/components/analytics-collection-settings";
import { LiveWritesSettings } from "@/components/live-writes-settings";
import { McpConnectionSettings } from "@/components/mcp-connection-settings";
import { ReadGatewaySettings } from "@/components/read-gateway-settings";
import { CloudConnectionSettings } from "@/components/cloud-connection-settings";
import { ChannelConnectionsSettings } from "@/components/channel-connections-settings";
import { SyncFolderSettings } from "@/components/sync-folder-settings";
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

// Settings sub-tabs (owner instruction, 2026-09-23: "давай в настройках сделаем 4 категории
// закладок"). "AI Agent" deliberately groups two technically unrelated mechanisms -- the MCP
// connection toggle (how an external AI agent like Codex/Claude connects TO this app) and AI
// provider connections (how this app connects OUT to an AI provider for AI Localization) -- per
// the owner's own explicit choice after this distinction was raised and confirmed understood.
const SETTINGS_SUB_TABS = [
  { value: "api", label: "API" },
  { value: "channels", label: "Channels" },
  { value: "ai-agent", label: "AI Agent" },
  { value: "sync", label: "Sync" },
  { value: "about", label: "About" },
] as const;
type SettingsSubTab = (typeof SETTINGS_SUB_TABS)[number]["value"];

export default function Dashboard() {
  const { data: session, status } = useSession();
  const [tab, setTab] = useState<Tab>("home");
  const [settingsSubTab, setSettingsSubTab] = useState<SettingsSubTab>("api");
  const [channel, setChannel] = useState<ChannelInfo | null>(null);
  const [conflictCount, setConflictCount] = useState(0);

  const fetchChannel = useCallback(async () => {
    try {
      const res = await fetch("/api/youtube/channel-info");
      if (!res.ok) return;
      const data = await res.json();
      setChannel(data.channel);
    } catch {
      // Non-fatal -- can genuinely fail transiently right as the session cookie is swapping (e.g.
      // right after activating a different stored channel connection, docs/decisions/0010), since
      // that no longer reloads the page the way the old signIn("google")-only flow always did.
      // This effect re-runs the moment `session` settles on its new value, so it self-heals.
    }
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

      {/* Unlike every other top-level tab (still conditionally mounted -- see AGENTS.md-documented
          convention that most tabs refetch for free on their own mount/unmount), Settings itself
          stays mounted from dashboard load onward and is only CSS-hidden when inactive (owner
          follow-up: "можно какой-то кэш подгружать еще на этапе загрузки приложения?"). Every
          card below starts its own fetch as soon as the dashboard loads, not only once Settings
          is first opened -- so by the time an operator actually clicks Settings, most cards
          already have data. Deliberate cost tradeoff, stated plainly: `CloudConnectionSettings`'s
          quota numbers are a real, uncached Google Cloud Monitoring API call (`docs/SYSTEM_MAP.md`
          §2.9l) -- this now fires once per dashboard session regardless of whether Settings is
          ever opened, not only when it is. Every other card here reads local SQLite, negligible
          either way. */}
      <div className={tab === "settings" ? "max-w-3xl" : "hidden"}>
        <div className="mb-6 inline-flex gap-1 rounded-lg bg-zinc-950 p-1">
          {SETTINGS_SUB_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setSettingsSubTab(t.value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                settingsSubTab === t.value ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Every sub-tab's content stays mounted (hidden via CSS, not unmounted) once first
            shown -- found live (owner: "почему при переключении подкатегорий наполнение
            вкладки видно не сразу?"): each card below does its own fetch-on-mount, so
            conditionally unmounting on every switch forced a fresh loading flicker (or a blank
            `if (!draft) return null` render) every single time, even for a sub-tab already
            visited this session. Hidden-not-unmounted keeps each card's already-fetched state,
            so only the FIRST visit to a sub-tab shows a loading moment. */}
        <div className={settingsSubTab === "api" ? "space-y-6" : "hidden"}>
          <LiveWritesSettings />
          <ReadGatewaySettings />
          <CloudConnectionSettings />
          <AnalyticsCollectionSettings />
        </div>

        <div className={settingsSubTab === "channels" ? "space-y-6" : "hidden"}>
          <ChannelConnectionsSettings />
        </div>

        <div className={settingsSubTab === "ai-agent" ? "space-y-6" : "hidden"}>
          <McpConnectionSettings />
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <h3 className="mb-4 flex items-center gap-1.5 text-base font-semibold text-zinc-100">
              AI provider connections
              <InfoTooltip>
                Configure AI provider connections for AI Localization. No specific vendor is
                built into this app &mdash; every connection is a Base URL, model id, and
                optional credential you supply. Credentials are encrypted at rest and never
                shown again once saved. Testing a connection is an explicit action and may
                incur cost for a real (non-mock) connection. Unrelated to the MCP connection
                above (that&rsquo;s an external agent connecting TO this app; this is this app
                connecting OUT to an AI provider) &mdash; grouped here for convenience.
              </InfoTooltip>
            </h3>
            <AiConnectionsManager />
          </div>
        </div>

        <div className={settingsSubTab === "sync" ? "space-y-6" : "hidden"}>
          <SyncFolderSettings />
        </div>

        <div className={settingsSubTab === "about" ? "space-y-6" : "hidden"}>
          <AppVersionInfo />
        </div>
      </div>

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
