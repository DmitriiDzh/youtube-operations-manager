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

type Tab = "manual" | "rules" | "sync" | "localizations" | "ai-localization" | "batches" | "settings";

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
    <div className="mx-auto max-w-3xl px-4 py-12">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">YouTube Playlist Manager</h1>
          <p className="text-sm text-zinc-400">
            Welcome, {session.user?.name}
          </p>
        </div>
        <button
          onClick={() => signOut()}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
        >
          Sign Out
        </button>
      </div>

      <div className="mb-6 flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
        <div className="flex items-center gap-3">
          {channel?.thumbnail && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={channel.thumbnail}
              alt={channel.title}
              className="h-10 w-10 rounded-full"
            />
          )}
          <div>
            <p className="text-xs text-zinc-500">Active YouTube channel</p>
            <p className="font-medium">
              {channel?.title ?? "Loading..."}
              {channel?.videoCount && (
                <span className="ml-2 text-xs text-zinc-500">
                  {channel.videoCount} videos
                </span>
              )}
            </p>
          </div>
        </div>
        <button
          onClick={handleSwitchChannel}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800"
        >
          Switch Channel
        </button>
      </div>

      <div className="mb-6 flex gap-1 rounded-lg bg-zinc-900 p-1">
        <button
          onClick={() => setTab("manual")}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === "manual"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Manual
        </button>
        <button
          onClick={() => setTab("rules")}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === "rules"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Rules
        </button>
        <button
          onClick={() => setTab("sync")}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === "sync"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Sync
        </button>
        <button
          onClick={() => setTab("localizations")}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === "localizations"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Localizations
        </button>
        <button
          onClick={() => setTab("ai-localization")}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === "ai-localization"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          AI Localization
        </button>
        <button
          onClick={() => setTab("batches")}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === "batches"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Batches
        </button>
        <button
          onClick={() => setTab("settings")}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            tab === "settings"
              ? "bg-zinc-800 text-white"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Settings
        </button>
      </div>

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
    </div>
  );
}
