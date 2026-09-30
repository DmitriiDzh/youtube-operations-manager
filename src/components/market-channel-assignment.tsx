"use client";

import { useCallback, useEffect, useState } from "react";

type RecordKind = "research_channel" | "topic" | "trend_candidate" | "discovery_candidate" | "research_request";
type Assignment = { recordKind: RecordKind; recordId: string; channelIds: string[] };

type ConnectedChannel = { channelId: string; title: string };

// Many rows mount at once -- share one in-flight GET for the channel list (read-only
// /api/channel-connections, deliberately NOT useConnectedChannels, which also triggers a sync on
// every mount) and one per assignment kind.
let inflightChannels: Promise<ConnectedChannel[]> | null = null;

function fetchConnectedChannels(): Promise<ConnectedChannel[]> {
  if (!inflightChannels) {
    inflightChannels = (async () => {
      const res = await fetch("/api/channel-connections");
      if (!res.ok) throw new Error("load failed");
      return ((await res.json()) as { channels: ConnectedChannel[] }).channels;
    })().finally(() => {
      inflightChannels = null;
    });
  }
  return inflightChannels;
}

const inflightByKind = new Map<RecordKind, Promise<Assignment[]>>();

function fetchAssignments(recordKind: RecordKind): Promise<Assignment[]> {
  let inflight = inflightByKind.get(recordKind);
  if (!inflight) {
    inflight = (async () => {
      const res = await fetch(`/api/market-assignments?recordKind=${recordKind}`);
      if (!res.ok) throw new Error("load failed");
      return ((await res.json()) as { assignments: Assignment[] }).assignments;
    })().finally(() => {
      inflightByKind.delete(recordKind);
    });
    inflightByKind.set(recordKind, inflight);
  }
  return inflight;
}

/**
 * Phase 12 slice 12.4 (`docs/roadmap/plans/PHASE_12_PLAN.md`, owner decision D1: shared collection,
 * then give each channel what it needs). Per-record chips, one per connected channel: which
 * channels' agents may see this market record. A channel's agent sees only what is toggled on for
 * its channel. Operator-only UI; each toggle saves immediately.
 */
export function MarketChannelAssignment({ recordKind, recordId }: { recordKind: RecordKind; recordId: string }) {
  const [channels, setChannels] = useState<ConnectedChannel[] | null>(null);
  const [assigned, setAssigned] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [all, connected] = await Promise.all([fetchAssignments(recordKind), fetchConnectedChannels()]);
      setChannels(connected);
      setAssigned(all.find((a) => a.recordId === recordId)?.channelIds ?? []);
    } catch {
      setError("Could not load channel assignments.");
    }
  }, [recordKind, recordId]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(channelId: string) {
    if (!assigned) return;
    const next = assigned.includes(channelId) ? assigned.filter((id) => id !== channelId) : [...assigned, channelId];
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/market-assignments", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recordKind, recordId, channelIds: next }),
      });
      const data = (await res.json()) as { assignment?: Assignment; message?: string };
      if (!res.ok || !data.assignment) {
        setError(data.message ?? "Failed to save");
        return;
      }
      setAssigned(data.assignment.channelIds);
    } catch {
      setError("Failed to save");
    } finally {
      setBusy(false);
    }
  }

  if (!channels || channels.length === 0 || assigned === null) {
    return error ? <p className="text-xs text-red-400">{error}</p> : null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-zinc-500">Visible to agents of:</span>
      {channels.map((channel) => {
        const on = assigned.includes(channel.channelId);
        return (
          <button
            key={channel.channelId}
            onClick={() => toggle(channel.channelId)}
            disabled={busy}
            aria-pressed={on}
            className={
              on
                ? "rounded-full border border-indigo-700 bg-indigo-950/60 px-2 py-0.5 text-indigo-300 disabled:opacity-50"
                : "rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-500 hover:border-zinc-500 disabled:opacity-50"
            }
          >
            {channel.title}
          </button>
        );
      })}
      {error && <span className="text-red-400">{error}</span>}
    </div>
  );
}
