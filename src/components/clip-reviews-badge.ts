"use client";

import { useEffect, useState } from "react";

// BL-241 (CLIP_REVIEWS_PLAN.md AC-CR-15; tab moved to Media, owner msg 4025): the «Клипы» tab's badge -- how many of the channel's
// clips wait for the owner. Its own read once a minute, so Media works without the clips module; a failed read shows no badge.

/** Pure: the badge from the read (null when it failed). */
export function clipsWaitingBadge(read: { waiting: number } | null): number {
  return Math.max(0, read?.waiting ?? 0);
}

export function useClipsWaiting(channelId: string | null): number {
  const [state, setState] = useState<{ channelId: string | null; waiting: number }>({ channelId: null, waiting: 0 });
  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    const url = `/api/channels/${encodeURIComponent(channelId)}/clip-reviews`;
    const read = () => {
      // A hidden browser tab reads nothing: the badge catches up when it is shown again.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void fetch(url)
        .then((res) => (res.ok ? (res.json() as Promise<{ waiting: number }>) : null))
        .catch(() => null)
        .then((body) => {
          if (!cancelled) setState({ channelId, waiting: clipsWaitingBadge(body) });
        });
    };
    read();
    const timer = setInterval(read, 60_000);
    document.addEventListener("visibilitychange", read);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [channelId]);
  return state.channelId === channelId ? state.waiting : 0;
}
