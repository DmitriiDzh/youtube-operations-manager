"use client";

import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Spinner } from "../operation-progress/spinner";
import { ACTION_DONE_FLASH_MS } from "./busy-state";

/**
 * BL-195 (UI_FEEDBACK_CLARITY_PLAN.md §3 stage A, AC-FB-04): a button that says it is working. While `busy` it shows a spinner and
 * `busyLabel` and cannot be pressed; each time `doneSignal` changes (the caller bumps it after a success) it shows "✓" with its
 * label for 2 s. Everything else is a plain `<button>` (the caller's classes, type, title).
 */
export function ActionButton({
  busy,
  busyLabel,
  doneSignal,
  children,
  disabled,
  type = "button",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { busy: boolean; busyLabel?: ReactNode; doneSignal?: number; children: ReactNode }) {
  const [flash, setFlash] = useState(false);
  // A new success (the signal changed) starts the "✓"; adjusted while rendering, as React advises for a prop change.
  const [seenSignal, setSeenSignal] = useState(doneSignal);
  if (doneSignal !== seenSignal) {
    setSeenSignal(doneSignal);
    if (doneSignal) setFlash(true);
  }
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(false), ACTION_DONE_FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash, doneSignal]);
  return (
    <button type={type} disabled={busy || disabled} aria-busy={busy || undefined} {...rest}>
      {busy ? (
        <span className="inline-flex items-center gap-1.5">
          <Spinner className="h-3.5 w-3.5" />
          {busyLabel ?? children}
        </span>
      ) : flash ? (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden>✓</span>
          {children}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
