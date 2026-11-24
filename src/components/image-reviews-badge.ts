"use client";

import { useEffect, useState } from "react";
import { startVisibleInterval } from "./visible-interval";

// BL-272 (ADR 0076): the «Кадры» tab's badge -- how many of the channel's master stills wait for the owner. Its own read once a
// minute, so Media works without the image-reviews module; a failed read shows no badge. It asks the count-only view (`?view=count`):
// the document alone, no file work on the channel's images.

/** Pure: the badge from the read (null when it failed). */
export function stillsWaitingBadge(read: { waiting: number } | null): number {
  return Math.max(0, read?.waiting ?? 0);
}

/** Pure: the badge's address -- the count-only view of the owner's list. */
export function stillsWaitingUrl(channelId: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/image-reviews?view=count`;
}

export function useStillsWaiting(channelId: string | null): number {
  const [state, setState] = useState<{ channelId: string | null; waiting: number }>({ channelId: null, waiting: 0 });
  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    const url = stillsWaitingUrl(channelId);
    const read = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void fetch(url)
        .then((res) => (res.ok ? (res.json() as Promise<{ waiting: number }>) : null))
        .catch(() => null)
        .then((body) => {
          if (!cancelled) setState({ channelId, waiting: stillsWaitingBadge(body) });
        });
    };
    read();
    const stopPolling = startVisibleInterval(read, 60_000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [channelId]);
  return state.channelId === channelId ? state.waiting : 0;
}
