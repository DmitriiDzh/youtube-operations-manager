"use client";

import { useEffect, useState } from "react";
import type { StepStatus } from "./startup-progress";

// BL-149 follow-up (owner, Telegram 2026-10-07, msg 2004): a blurred screen with a loading window while the app loads its data
// on open and while the active channel switches -- so it is clear that work is in progress and nothing should be clicked
// yet. After a while it can be dismissed: the work continues in the background either way.

const DISMISS_AFTER_MS = 10_000;

const ICON: Record<StepStatus["state"], string> = { waiting: "○", running: "", done: "✓", skipped: "–", failed: "!" };
const TONE: Record<StepStatus["state"], string> = {
  waiting: "text-zinc-500",
  running: "text-zinc-100",
  done: "text-emerald-400",
  skipped: "text-zinc-400",
  failed: "text-amber-400",
};

export function LoadingOverlay({ title, steps, onDismiss }: { title: string; steps: ReadonlyArray<{ key: string; label: string; status: StepStatus }>; onDismiss: () => void }) {
  const [canDismiss, setCanDismiss] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setCanDismiss(true), DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-950/40 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-[26rem] max-w-[90vw] rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-indigo-400" aria-hidden />
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        </div>
        <ul className="mt-4 space-y-2">
          {steps.map((s) => (
            <li key={s.key} className={`flex items-start gap-2 text-sm ${TONE[s.status.state]}`}>
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-xs">
                {s.status.state === "running" ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-200" aria-hidden /> : ICON[s.status.state]}
              </span>
              <span>
                {s.label}
                {s.status.detail && <span className="text-zinc-500"> · {s.status.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
        {canDismiss && (
          <button type="button" onClick={onDismiss} className="mt-4 text-xs text-zinc-400 underline hover:text-zinc-200">
            Continue in the background
          </button>
        )}
      </div>
    </div>
  );
}
