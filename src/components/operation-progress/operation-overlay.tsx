"use client";

import { useEffect, useState } from "react";
import { BlockingDialog } from "../blocking-dialog";
import { ProgressBar } from "../progress-bar";
import { blocksKey, isOperationActive, type OperationItemStatus, type OperationState } from "./operation-state";
import { Spinner } from "./spinner";
import { SuccessMark } from "./success-mark";

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const QUOTA_LABEL = { dataApi: "YouTube Data API quota (24h)", analytics: "YouTube Analytics API quota (24h)" } as const;

const ITEM_MARK: Record<OperationItemStatus, { mark: string; className: string }> = {
  pending: { mark: "·", className: "text-zinc-600" },
  running: { mark: "…", className: "text-amber-400" },
  done: { mark: "✓", className: "text-emerald-400" },
  failed: { mark: "✗", className: "text-red-400" },
  skipped: { mark: "–", className: "text-zinc-500" },
};

const FINISHED_TITLE: Record<"success" | "failed" | "cancelled", string> = {
  success: "Done",
  failed: "Stopped with an error",
  cancelled: "Cancelled",
};

/**
 * The shared blocking progress dialog: dims and blurs everything behind it so nothing else in the
 * app can be clicked while a write/sync is running, cannot be dismissed (no Esc / backdrop click)
 * until the operation ends, and shows stage, X / Y, elapsed time and a per-item list. It is a UX
 * guard for this tab only -- cross-tab / agent exclusion is still the server-side lock's job.
 */
export function OperationOverlay({
  state,
  onCancel,
  onClose,
}: {
  state: OperationState;
  onCancel?: () => void;
  onClose: () => void;
}) {
  const active = isOperationActive(state);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  // Capture phase + stopImmediatePropagation: runs before a window-level Escape handler of whatever is
  // underneath (VideoDetailModal closes on Escape and would unmount the panel mid-save).
  useEffect(() => {
    if (!active) return;
    const swallow = (event: KeyboardEvent) => {
      if (blocksKey(state, event.key)) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", swallow, true);
    return () => window.removeEventListener("keydown", swallow, true);
  }, [active, state]);

  if (state.status === "idle") return null;

  const elapsedEnd = state.finishedAt ?? now;
  const elapsed = state.startedAt === null ? 0 : elapsedEnd - state.startedAt;
  const finishedStatus = state.status === "success" || state.status === "failed" || state.status === "cancelled" ? state.status : null;
  const failedItems = state.items.filter((item) => item.status === "failed").length;

  return (
    <BlockingDialog label={state.title} busy={active}>
      <div className="flex items-center gap-2">
        {active && <Spinner />}
        {state.status === "success" && <SuccessMark />}
        <p className={`text-sm font-medium ${state.status === "success" ? "text-emerald-300" : "text-zinc-100"}`}>{finishedStatus ? `${state.title} — ${FINISHED_TITLE[finishedStatus]}` : state.title}</p>
        <span className="ml-auto text-xs tabular-nums text-zinc-500">{formatElapsed(elapsed)}</span>
      </div>

      {active && (
        <p className="text-xs text-zinc-400">
          {state.status === "cancelling"
            ? "Stopping after the current item — a write already sent to YouTube cannot be recalled."
            : state.stage ?? "Working…"}
        </p>
      )}
      {state.total > 0 && (
        <ProgressBar value={state.done} max={state.total} label={`${state.done} / ${state.total}${failedItems ? ` · ${failedItems} failed` : ""}`} />
      )}
      {state.quotas.map((q) => (
        <ProgressBar
          key={q.service}
          value={q.used}
          max={q.limit}
          color="indigo"
          label={`${QUOTA_LABEL[q.service]}: ${q.used.toLocaleString()} / ${q.limit.toLocaleString()} · this operation +${Math.max(0, q.used - q.baseline).toLocaleString()} units`}
        />
      ))}
      {state.quotas.length > 0 && (
        <p className="text-[11px] text-zinc-600">Google reports usage with a delay of about a minute, so the figure may lag.</p>
      )}
      {active && <p className="text-xs text-zinc-500">Keep this window open until it finishes.</p>}
      {state.message && (
        <p className={`text-xs ${state.status === "failed" ? "text-red-400" : "text-zinc-300"}`}>{state.message}</p>
      )}

      {state.items.length > 0 && (
        <ul className="max-h-60 space-y-0.5 overflow-auto rounded-md border border-zinc-800 p-2 text-xs">
          {state.items.map((item) => (
            <li key={item.id} className="flex gap-2">
              <span className={`w-3 shrink-0 text-center ${ITEM_MARK[item.status].className}`}>{ITEM_MARK[item.status].mark}</span>
              <span className="min-w-0 flex-1 truncate text-zinc-300" title={item.label}>
                {item.label}
              </span>
              {item.detail && <span className="shrink-0 truncate text-red-400">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end gap-2">
        {active && state.cancellable && onCancel && (
          <button
            onClick={onCancel}
            disabled={state.status === "cancelling"}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
          >
            {state.status === "cancelling" ? "Stopping…" : "Cancel"}
          </button>
        )}
        {!active && (
          <button onClick={onClose} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500">
            Close
          </button>
        )}
      </div>
    </BlockingDialog>
  );
}
