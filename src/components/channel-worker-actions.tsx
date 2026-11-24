"use client";

import { useCallback, useRef, useState } from "react";
import { isUiTextKey } from "@/lib/ui-text";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { InfoTooltip } from "./info-tooltip";
import { WriteLogDetail } from "./write-log-detail";
import { useT } from "./ui-text-provider";

type WorkerAction = { at: string; tool: string; target: string | null; detail: string | null; outcome: "ok" | "error"; errorCode: string | null };

/** Codes that mean the app refused the call (a rule, not a YouTube or network failure). */
const REFUSAL_CODES = new Set(["AGENT_PUBLIC_NOT_ALLOWED", "AGENT_TOKEN_INVALID", "CHANNEL_NOT_ACTIVE", "WRITE_CHANNEL_MISMATCH", "live_writes_disabled"]);

/**
 * BL-215 (ADR 0048, WORKER_CAPABILITIES_PLAN.md AC-WK-10): what this channel's agent wrote to YouTube on this computer, refused
 * calls included, newest first. Collapsed by default and loaded only when opened, so Settings → Channels makes no extra request per
 * channel row. Read-only.
 */
export function ChannelWorkerActions({ channelId }: { channelId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<WorkerAction[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Only the newest request may set the list (Show and Refresh can overlap).
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    setFailed(false);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/worker-actions`);
      if (!res.ok) throw new Error("load failed");
      const loaded = ((await res.json()) as { actions: WorkerAction[] }).actions;
      if (request === latest.current) setActions(loaded);
    } catch {
      if (request === latest.current) {
        setActions(null);
        setFailed(true);
      }
    }
  }, [channelId]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) load();
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-300">
        {t("settingsCards.workerActions.title")}
        <InfoTooltip>{t("settingsCards.workerActions.info")}</InfoTooltip>
        <button onClick={toggle} className="text-zinc-500 underline hover:text-zinc-300">
          {open ? t("settingsCards.workerActions.hide") : t("settingsCards.workerActions.show")}
        </button>
        {open && (
          <button onClick={() => load()} className="text-zinc-500 underline hover:text-zinc-300">
            {t("settingsCards.workerActions.refresh")}
          </button>
        )}
      </div>
      {open && failed && <p className="text-xs text-red-400">{t("settingsCards.workerActions.loadFailed")}</p>}
      {open && actions && actions.length === 0 && <p className="text-xs text-zinc-500">{t("settingsCards.workerActions.empty")}</p>}
      {open && actions && actions.length > 0 && (
        <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-zinc-800 p-2 text-[11px] text-zinc-400">
          {actions.map((action, index) => {
            const toolKey = `settingsCards.workerActions.tool.${action.tool}`;
            return (
              <li key={`${action.at}-${index}`} className="flex flex-wrap gap-x-2">
                <span className="text-zinc-500">{formatDisplayDateTime(action.at)}</span>
                <span className="text-zinc-200">{isUiTextKey(toolKey) ? t(toolKey) : action.tool}</span>
                <WriteLogDetail target={action.target} detail={action.detail} />
                {action.outcome === "ok" ? (
                  <span className="text-emerald-400">{t("settingsCards.workerActions.done")}</span>
                ) : (
                  <span className="text-red-400">
                    {action.errorCode && REFUSAL_CODES.has(action.errorCode) ? t("settingsCards.workerActions.refused") : t("settingsCards.workerActions.failed")}
                    {action.errorCode ? ` (${action.errorCode})` : ""}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
