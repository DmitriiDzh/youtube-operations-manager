"use client";

import { useCallback, useEffect, useState } from "react";

// BL-157 (docs/roadmap/plans/SERVERS_MEDIA_PLAN.md AC-SM-05/AC-MV-07): a channel id shown to the owner is shown by the
// channel's name -- Servers' sessions, a plan's move, the other channels' work. A plain read of the connected channels
// (`GET /api/channel-connections`, no sync, no token in it); a channel not connected here shows its id.

export type ChannelLabel = { channelId: string; title: string; thumbnailUrl: string | null };

/** The name to show for a channel id (pure; exported for its test). */
export function channelNameOf(channels: readonly ChannelLabel[] | null, channelId: string): string {
  return channels?.find((c) => c.channelId === channelId)?.title || channelId;
}

export function useChannelNames(): { channels: ChannelLabel[] | null; nameOf: (channelId: string) => string } {
  const [channels, setChannels] = useState<ChannelLabel[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/channel-connections");
        if (!res.ok) return;
        const data = (await res.json()) as { channels?: ChannelLabel[] };
        if (!cancelled) setChannels((data.channels ?? []).map((c) => ({ channelId: c.channelId, title: c.title, thumbnailUrl: c.thumbnailUrl ?? null })));
      } catch {
        // Non-fatal: ids are shown until the next mount.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const nameOf = useCallback((channelId: string) => channelNameOf(channels, channelId), [channels]);
  return { channels, nameOf };
}
