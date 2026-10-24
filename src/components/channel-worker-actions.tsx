"use client";

import { useCallback, useState } from "react";
import { isUiTextKey } from "@/lib/ui-text";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { InfoTooltip } from "./info-tooltip";
import { useT } from "./ui-text-provider";

type WorkerAction = { at: string; tool: string; target: string | null; detail: string | null; outcome: "ok" | "error"; errorCode: string | null };

/** The few fields of a row's detail the owner reads at a glance; anything else stays out of the list. */
function readDetail(detail: string | null): { privacyStatus?: string; videoCount?: number; failedVideos?: number } {
  try {
    const parsed = detail ? (JSON.parse(detail) as Record<string, unknown>) : {};
    return {
      privacyStatus: typeof parsed.privacyStatus === "string" ? parsed.privacyStatus : undefined,
      videoCount: Array.isArray(parsed.videoIds) ? parsed.videoIds.length : undefined,
      failedVideos: typeof parsed.failedVideos === "number" && parsed.failedVideos > 0 ? parsed.failedVideos : undefined,
    };
  } catch {
    // A long list is cut in storage and is no longer JSON: show the row without its detail.
    return {};
  }
}

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

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/worker-actions`);
      if (!res.ok) throw new Error("load failed");
      setActions(((await res.json()) as { actions: WorkerAction[] }).actions);
    } catch {
      setFailed(true);
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
            const detail = readDetail(action.detail);
            return (
              <li key={`${action.at}-${index}`} className="flex flex-wrap gap-x-2">
                <span className="text-zinc-500">{formatDisplayDateTime(action.at)}</span>
                <span className="text-zinc-200">{isUiTextKey(toolKey) ? t(toolKey) : action.tool}</span>
                {action.target && <span className="font-mono">{action.target}</span>}
                {detail.privacyStatus && <span>{t("settingsCards.workerActions.privacy", { status: detail.privacyStatus })}</span>}
                {detail.videoCount !== undefined && <span>{t("settingsCards.workerActions.videos", { count: String(detail.videoCount) })}</span>}
                {detail.failedVideos !== undefined && (
                  <span className="text-amber-400">{t("settingsCards.workerActions.failedVideos", { count: String(detail.failedVideos) })}</span>
                )}
                {action.outcome === "ok" ? (
                  <span className="text-emerald-400">{t("settingsCards.workerActions.done")}</span>
                ) : (
                  <span className="text-red-400">
                    {t("settingsCards.workerActions.refused")}
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
