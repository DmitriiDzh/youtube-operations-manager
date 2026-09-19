"use client";

import { useSession, signOut, signIn } from "next-auth/react";
import { redirect } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { RuleForm } from "@/components/rule-form";
import { RuleList } from "@/components/rule-list";
import { RunButton } from "@/components/run-button";
import { ManualMode } from "@/components/manual-mode";
import { ChannelSync } from "@/components/channel-sync";
import { LocalizationManager } from "@/components/localization-manager";
import { BatchManager } from "@/components/batch-manager";
import { AiLocalizationPanel } from "@/components/ai-localization-panel";
import { AiConnectionsManager } from "@/components/ai-connections-manager";
import { DeviceHandoffPanel } from "@/components/device-handoff-panel";
import { AppShell, type NavItem } from "@/components/app-shell";
import {
  AiLocalizationIcon,
  BatchesIcon,
  DeviceIcon,
  LocalizationsIcon,
  ManualIcon,
  RulesIcon,
  SettingsIcon,
  SyncIcon,
} from "@/components/icons";

type ChannelInfo = {
  id: string;
  title: string;
  thumbnail?: string;
  videoCount?: string;
};

type Rule = {
  id: number;
  name: string;
  matchField: string;
  matchType: string;
  matchValue: string;
  playlistTitle: string;
  enabled: boolean;
};

type Tab =
  | "manual"
  | "rules"
  | "sync"
  | "localizations"
  | "ai-localization"
  | "batches"
  | "settings"
  | "device";

const NAV_ITEMS: NavItem<Tab>[] = [
  { value: "manual", label: "Manual", icon: ManualIcon },
  { value: "rules", label: "Rules", icon: RulesIcon },
  { value: "sync", label: "Sync", icon: SyncIcon },
  { value: "localizations", label: "Localizations", icon: LocalizationsIcon },
  { value: "ai-localization", label: "AI Localization", icon: AiLocalizationIcon },
  { value: "batches", label: "Batches", icon: BatchesIcon },
  { value: "settings", label: "Settings", icon: SettingsIcon },
  { value: "device", label: "Device", icon: DeviceIcon },
];

export default function Dashboard() {
  const { data: session, status } = useSession();
  const [rules, setRules] = useState<Rule[]>([]);
  const [tab, setTab] = useState<Tab>("manual");
  const [channel, setChannel] = useState<ChannelInfo | null>(null);

  const fetchRules = useCallback(async () => {
    const res = await fetch("/api/rules");
    const data = await res.json();
    setRules(data);
  }, []);

  const fetchChannel = useCallback(async () => {
    const res = await fetch("/api/youtube/channel-info");
    const data = await res.json();
    setChannel(data.channel);
  }, []);

  useEffect(() => {
    if (session) {
      queueMicrotask(() => {
        void fetchRules();
        void fetchChannel();
      });
    }
  }, [session, fetchRules, fetchChannel]);

  async function handleSwitchChannel() {
    await signOut({ redirect: false });
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

  async function handleDelete(id: number) {
    await fetch(`/api/rules?id=${id}`, { method: "DELETE" });
    fetchRules();
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
      {tab === "manual" && (
        <div>
          <p className="mb-4 text-sm text-zinc-400">
            Select videos and add them to a playlist directly.
          </p>
          <ManualMode />
        </div>
      )}

      {tab === "rules" && (
        <div className="space-y-8">
          <RuleForm onCreated={fetchRules} />

          <div>
            <h2 className="mb-4 text-lg font-semibold">Your Rules</h2>
            <RuleList rules={rules} onDelete={handleDelete} />
          </div>

          <div>
            <h2 className="mb-4 text-lg font-semibold">Execute</h2>
            <p className="mb-3 text-sm text-zinc-400">
              Run your rules against your recent videos.
            </p>
            <RunButton />
          </div>
        </div>
      )}

      {tab === "sync" && (
        <div>
          <p className="mb-4 text-sm text-zinc-400">
            Synchronize a channel&rsquo;s videos locally and review existing localization
            languages. Read-only: no metadata is written to YouTube.
          </p>
          <ChannelSync />
        </div>
      )}

      {tab === "localizations" && (
        <div>
          <p className="mb-4 text-sm text-zinc-400">
            Review existing localizations per video, export to XLSX, and import edited
            workbooks to build local change sets for review and approval. No metadata is
            written to YouTube anywhere in this tab &mdash; approval is a local decision only.
          </p>
          <LocalizationManager />
        </div>
      )}

      {tab === "ai-localization" && (
        <div>
          <p className="mb-4 text-sm text-zinc-400">
            Generate localization proposals with a deterministic mock AI provider, review
            and edit them, and turn them into a Change Set for the same approval workflow
            as an XLSX import. No real AI provider is called and no metadata is written to
            YouTube from this tab.
          </p>
          <AiLocalizationPanel />
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
        <div>
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
        <div>
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
