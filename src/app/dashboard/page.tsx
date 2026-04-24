"use client";

import { useSession, signOut, signIn } from "next-auth/react";
import { redirect } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { RuleForm } from "@/components/rule-form";
import { RuleList } from "@/components/rule-list";
import { RunButton } from "@/components/run-button";
import { ManualMode } from "@/components/manual-mode";

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

type Tab = "manual" | "rules";

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
      </div>

      {tab === "manual" ? (
        <div>
          <p className="mb-4 text-sm text-zinc-400">
            Select videos and add them to a playlist directly.
          </p>
          <ManualMode />
        </div>
      ) : (
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
    </div>
  );
}
