"use client";

import { useSession, signOut, signIn } from "next-auth/react";
import { redirect } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import type { ComponentType, SVGProps } from "react";
import { ContentManager } from "@/components/content-manager";
import { LanguagesManager } from "@/components/languages-manager";
import { BatchManager } from "@/components/batch-manager";
import { AiConnectionsManager } from "@/components/ai-connections-manager";
import { AppVersionInfo } from "@/components/app-version-info";
import { EditorialProfilePanel } from "@/components/editorial-profile-panel";
import { DeviceHandoffPanel } from "@/components/device-handoff-panel";
import { AppShell } from "@/components/app-shell";
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
  { value: "device", label: "Device", icon: DeviceIcon },
] as const satisfies {
  value: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}[];

type Tab = (typeof NAV_ITEMS)[number]["value"];

export default function Dashboard() {
  const { data: session, status } = useSession();
  const [tab, setTab] = useState<Tab>("home");
  const [channel, setChannel] = useState<ChannelInfo | null>(null);

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
      navItems={NAV_ITEMS}
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
        <div className="max-w-3xl">
          <p className="text-sm text-zinc-400">
            Coming soon — real analytics data requires the YouTube Analytics API and a new
            OAuth scope, gated on its own separate decision
            (docs/roadmap/plans/PHASE_8_PLAN.md, docs/roadmap/plans/STUDIO_PARITY_PLAN.md Slice
            S6).
          </p>
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
            Select approved changes into a Batch and preview it in dry-run mode. Real
            YouTube writes are disabled by a server-side safety barrier &mdash; this tab
            never performs a live write.
          </p>
          <BatchManager />
        </div>
      )}

      {tab === "settings" && (
        <div className="max-w-3xl">
          <AppVersionInfo />
          <p className="mb-4 text-sm text-zinc-400">
            Configure AI provider connections for AI Localization. No specific vendor is
            built into this app &mdash; every connection is a Base URL, model id, and
            optional credential you supply. Credentials are encrypted at rest and never
            shown again once saved. Testing a connection is an explicit action and may
            incur cost for a real (non-mock) connection.
          </p>
          <AiConnectionsManager />
        </div>
      )}

      {tab === "device" && (
        <div className="max-w-3xl">
          <p className="mb-4 text-sm text-zinc-400">
            One active device at a time. Export a handoff snapshot when finishing work here,
            import one to continue on this device. Syncthing only carries the snapshot files
            &mdash; it is never treated as a database, and no OAuth token or AI connection
            credential ever leaves this device.
          </p>
          <DeviceHandoffPanel />
        </div>
      )}
    </AppShell>
  );
}
