"use client";

import { useEffect, useRef } from "react";

const POLL_MS = 15_000;

/**
 * BL-178 part C (docs/roadmap/plans/LOCALIZATION_BASELINE_PLAN.md §3.3 C1, FO-REQ-0022 §5): calls `onChange` when the channel's
 * localization version moves -- a Batch run from the Batches page or by an agent, a sync, a language setting from the other
 * computer -- so an open page shows it without a manual sync. Polls every 15 s while the tab is visible (and at once when it
 * becomes visible again); the first answer only sets the starting point. A local read: never a YouTube call.
 */
export function useLocalizationVersion(channelId: string | null | undefined, onChange: () => void, pollMs = POLL_MS): void {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!channelId) return;
    const url = `/api/channels/${encodeURIComponent(channelId)}/localizations/version`;
    let last: string | null = null;
    let cancelled = false;
    async function check() {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(url);
        if (!res.ok || cancelled) return;
        const { version } = (await res.json()) as { version?: unknown };
        if (cancelled || typeof version !== "string") return;
        if (last !== null && version !== last) onChangeRef.current();
        last = version;
      } catch {
        // Non-fatal -- the next poll tries again.
      }
    }
    void check();
    const id = setInterval(() => void check(), pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [channelId, pollMs]);
}
