"use client";

import { useCallback, useEffect, useState } from "react";
import type { Translate } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";

type RecordKind = "research_channel" | "topic" | "trend_candidate" | "discovery_candidate" | "research_request" | "collection_request";
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
 * its channel. Operator-only UI; each toggle saves immediately. `onChange` lets a list that shows a
 * "Visible to: N channels" pill (BL-140 §4.7) update after a save without refetching.
 */
export function MarketChannelAssignment({
  recordKind,
  recordId,
  onChange,
}: {
  recordKind: RecordKind;
  recordId: string;
  onChange?: (channelIds: string[]) => void;
}) {
  const t = useT();
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
      setError(t("assignment.loadFailed"));
    }
  }, [recordKind, recordId, t]);

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
        setError(data.message ?? t("assignment.saveFailed"));
        return;
      }
      setAssigned(data.assignment.channelIds);
      onChange?.(data.assignment.channelIds);
    } catch {
      setError(t("assignment.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!channels || channels.length === 0 || assigned === null) {
    return error ? <p className="text-xs text-red-400">{error}</p> : null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-zinc-500">{t("assignment.visibleToLabel")}</span>
      {[
        ...channels,
        // A channel assigned before it was disconnected stays visible so it can be removed.
        ...assigned
          .filter((id) => !channels.some((channel) => channel.channelId === id))
          .map((id) => ({ channelId: id, title: t("assignment.disconnected", { id }) })),
      ].map((channel) => {
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

/**
 * BL-140 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.7): one read of every assignment of a kind plus the
 * connected channels, for lists that show a compact "Visible to" pill per row and edit in the record's drawer. `set`
 * takes MarketChannelAssignment's `onChange` result so the pill follows an edit without refetching. A failed read
 * leaves both empty (pills say "No channels", the "visible to" filter has no options) -- never a blocking error.
 */
export function useMarketAssignments(recordKind: RecordKind) {
  const [assignments, setAssignments] = useState<Map<string, string[]>>(new Map());
  const [connectedChannels, setConnectedChannels] = useState<ConnectedChannel[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAssignments(recordKind), fetchConnectedChannels()])
      .then(([all, connected]) => {
        if (cancelled) return;
        setAssignments(new Map(all.map((a) => [a.recordId, a.channelIds])));
        setConnectedChannels(connected);
      })
      .catch(() => {
        // Non-fatal, see above.
      });
    return () => {
      cancelled = true;
    };
  }, [recordKind]);

  const set = useCallback((recordId: string, channelIds: string[]) => {
    setAssignments((prev) => new Map(prev).set(recordId, channelIds));
  }, []);

  return { assignments, connectedChannels, set };
}

/** "No channels", the one channel's title, or "N channels". Exported for its test. */
export function describeVisibleTo(t: Translate, channelIds: string[], connectedChannels: ConnectedChannel[]): string {
  if (channelIds.length === 0) return t("assignment.noChannels");
  if (channelIds.length === 1) return connectedChannels.find((c) => c.channelId === channelIds[0])?.title ?? t("assignment.channelCount", { count: 1 });
  return t("assignment.channelCount", { count: channelIds.length });
}

export function VisibleToPill({ channelIds, connectedChannels }: { channelIds: string[]; connectedChannels: ConnectedChannel[] }) {
  const t = useT();
  return (
    <span className="whitespace-nowrap rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-400" title={t("assignment.pillTitle")}>
      {describeVisibleTo(t, channelIds, connectedChannels)}
    </span>
  );
}
