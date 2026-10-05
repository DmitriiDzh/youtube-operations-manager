"use client";

import { useCallback, useEffect, useState } from "react";
import { signIn } from "next-auth/react";

export type ConnectedChannel = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  connectedEmail: string;
  connectedAt: string;
  isActive: boolean;
};

/**
 * Shared list-fetching for the two places that show "which channels are connected"
 * (`channel-connections-settings.tsx`'s full Settings management view, and `channel-switcher.tsx`'s
 * topbar quick-switch dropdown, owner instruction 2026-09-23 -- "Функционал максимально должен
 * использовать тот что уже есть сейчас, мы просто создаем дополнительную визуальную обертку").
 * One hook, two call sites, no coupling between the components themselves.
 *
 * Each caller mounting this hook independently re-runs the mine-path sync below -- a small,
 * accepted duplicate cost (at most one extra `channel-sync` call per dashboard session, since both
 * current call sites mount once and stay mounted) rather than a fragile ordering dependency
 * between two otherwise-independent components.
 */
export function useConnectedChannels() {
  const [channels, setChannels] = useState<ConnectedChannel[] | null>(null);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch("/api/channel-connections");
      if (!res.ok) return;
      const data = (await res.json()) as { channels: ConnectedChannel[] };
      setChannels(data.channels);
    } catch {
      // Non-fatal -- the caller just keeps showing its last known list.
    }
  }, []);

  useEffect(() => {
    // A channel only gets linked into `channels.connectedUserId` (the field `listConnectedChannels`
    // filters on) by `channel-sync`'s own "mine" resolution -- `GET /api/youtube/channel-info`
    // (fetched automatically on every dashboard load) only ever updates `users.selectedChannelId`
    // (ADR 0004), never that link. Found live by the project owner testing "Connect a new
    // channel": without this, a freshly-connected channel never appeared here until the operator
    // separately visited Content/Languages, which happens to also trigger this same sync
    // (`docs/decisions/0010-persistent-channel-connections.md`).
    async function syncThenFetch() {
      try {
        await fetch("/api/channels/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch {
        // Non-fatal -- a pre-existing connection still lists correctly either way; this only
        // affects whether a *just-connected* channel shows up immediately.
      }
      await fetchChannels();
    }
    void syncThenFetch();
  }, [fetchChannels]);

  return { channels, refetch: fetchChannels };
}

/** Reactivates an already-connected channel's session without a Google round-trip (the
 * "channel-connections" NextAuth Credentials provider, `src/lib/auth.ts`). Returns whether it
 * succeeded so the caller can decide what to do next (close a dropdown, show an error, refetch). */
export async function activateStoredChannel(channelId: string): Promise<{ ok: boolean }> {
  try {
    const result = await signIn("channel-connections", { channelId, redirect: false });
    return { ok: !result?.error };
  } catch {
    return { ok: false };
  }
}
