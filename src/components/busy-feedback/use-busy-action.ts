"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BUSY_HOLD_MAX_MS, busyHideAt, busyWindow } from "./busy-state";

/** What `<BusyOverlay>` draws: shown or not, and the text of what is being done. */
export type BusyOverlayState = { visible: boolean; label: string };

/**
 * BL-195 (UI_FEEDBACK_CLARITY_PLAN.md §3 stage A): the blocking window of a screen's short actions. `run` wraps a request; `hold`
 * keeps the window up for a wait that is not a request (the next track's waveform) until `release` or BUSY_HOLD_MAX_MS. Requests
 * and holds that follow each other without a gap are one continuous wait, so the window never blinks between them. The window
 * itself follows `busyWindow` (shown after 300 ms, then at least 500 ms); `busy` is true from the first moment, so a screen can
 * refuse a second click or key at once.
 */
export function useBusyAction() {
  const [running, setRunning] = useState<string | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<BusyOverlayState>({ visible: false, label: "" });
  const count = useRef(0);
  const startedAt = useRef<number | null>(null);
  const shownAt = useRef<number | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = running !== null || held !== null;
  const label = running ?? held;

  useEffect(() => {
    const now = Date.now();
    const show = (text: string) => {
      if (shownAt.current === null) shownAt.current = Date.now();
      setOverlay({ visible: true, label: text });
    };
    if (busy) {
      if (startedAt.current === null) startedAt.current = now;
      const window = busyWindow(startedAt.current, null)!;
      // A window still shown from the wait just before stays up (with the new text) instead of blinking.
      if (now >= window.showAt || shownAt.current !== null) {
        show(label ?? "");
        return;
      }
      const timer = setTimeout(() => show(label ?? ""), window.showAt - now);
      return () => clearTimeout(timer);
    }
    startedAt.current = null;
    const hideAt = busyHideAt(shownAt.current, now);
    if (hideAt === null) return;
    const timer = setTimeout(() => {
      shownAt.current = null;
      setOverlay((o) => ({ ...o, visible: false }));
    }, hideAt - now);
    return () => clearTimeout(timer);
  }, [busy, label]);

  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    []
  );

  const run = useCallback(async <T,>(text: string, action: () => Promise<T>): Promise<T> => {
    count.current += 1;
    setRunning(text);
    try {
      return await action();
    } finally {
      count.current -= 1;
      if (count.current === 0) setRunning(null);
    }
  }, []);

  const release = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHeld(null);
  }, []);

  const hold = useCallback(
    (text: string) => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      holdTimer.current = setTimeout(release, BUSY_HOLD_MAX_MS);
      setHeld(text);
    },
    [release]
  );

  return { busy, run, hold, release, held: held !== null, overlay };
}

export type BusyAction = ReturnType<typeof useBusyAction>;
