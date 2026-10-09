"use client";

import { errorText } from "@/lib/ui-text";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import type { Translate, UiTextKey } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanChannelWork } from "@/lib/generation-plans/contracts";
import { otherChannelEntries } from "./channel-work";
import { useChannelNames } from "./use-channel-names";

/**
 * Automatic device sync notifications (docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md §3.7): a bell in
 * the header showing what the server-side sync last did, and anything that needs a human --
 * above all a divergence (both computers changed data). The choice itself is made in the Merge
 * tab, which shows what differs between the two versions (owner, Telegram 2026-10-06, msg 1758).
 *
 * BL-157 (docs/roadmap/plans/SERVERS_MEDIA_PLAN.md AC-BL-04..07, FO-REQ-0009 §3a, owner msg 2119): the bell also lists the open
 * Media work of every channel that is NOT active -- one entry per channel and type of work, with the channel's avatar and
 * name and a button that switches to it and opens the place. Entries come from the summary on every poll, so they update in
 * place and go away only when the work is done; they cannot be dismissed.
 */

type Notice = {
  kind: "divergence" | "update_app" | "recovery_mode" | "transfer_stuck" | "batch_in_progress" | "error";
  message: string;
  snapshotId?: string;
  sourceDeviceId?: string;
  createdAt?: string;
  localDirty?: boolean;
};

type SyncStatus = {
  enabled: boolean;
  state: "disabled" | "not_configured" | "folder_unreachable" | "busy" | "synced" | "exported" | "imported" | "waiting" | "attention";
  lastTickAt: string | null;
  lastExportAt: string | null;
  lastImportAt: string | null;
  notices: Notice[];
  busyReason: string | null;
  backgroundWritesPausedReason?: string | null;
};

const POLL_MS = 30_000;

const STATE_LABEL: Record<SyncStatus["state"], UiTextKey> = {
  disabled: "deviceSync.state.disabled",
  not_configured: "deviceSync.state.notConfigured",
  folder_unreachable: "deviceSync.state.folderUnreachable",
  busy: "deviceSync.state.busy",
  synced: "deviceSync.state.synced",
  exported: "deviceSync.state.exported",
  imported: "deviceSync.state.imported",
  waiting: "deviceSync.state.waiting",
  attention: "deviceSync.state.attention",
};

// DD.MM.YYYY HH:MM like every date in the app (owner rule 2026-09-26) -- this was a bare `toLocaleString()`.
function formatTime(t: Translate, iso: string | null): string {
  if (!iso) return t("common.never");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? t("common.never") : formatDisplayDateTime(date);
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0v1a3 3 0 1 1-6 0v-1m6 0H9" />
    </svg>
  );
}

export function DeviceSyncBell({
  onReviewDivergence,
  activeChannelId = null,
  channelWork = [],
  onOpenChannelWork,
}: {
  onReviewDivergence?: () => void;
  activeChannelId?: string | null;
  channelWork?: readonly PlanChannelWork[];
  onOpenChannelWork?: (channelId: string, href: string) => void;
}) {
  const t = useT();
  const { channels: channelLabels, nameOf } = useChannelNames();
  const entries = otherChannelEntries(t, channelWork, activeChannelId);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/device-sync/status");
      if (!res.ok) return;
      setStatus((await res.json()) as SyncStatus);
    } catch {
      // Non-fatal -- the bell keeps its last known state until the next poll.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function post(url: string, body?: unknown) {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(errorText(t, data, t("common.errorStatus", { status: res.status })));
        return;
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  }

  const notices = status?.notices ?? [];
  const attention = notices.length > 0;
  const dotClass = attention
    ? "bg-red-500"
    : status?.state === "waiting" || status?.state === "busy" || status?.state === "folder_unreachable"
      ? "bg-amber-400"
      : entries.length > 0
        ? "bg-sky-400"
        : null;

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={t("deviceSync.bellLabel")}
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted transition-colors hover:border-accent hover:text-white"
      >
        <BellIcon />
        {dotClass && <span className={`absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full ${dotClass}`} />}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 max-h-[80vh] w-96 space-y-3 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
          {entries.length > 0 && (
            <div className="space-y-2 border-b border-zinc-800 pb-3">
              <h3 className="text-sm font-semibold text-zinc-100">{t("channelWork.title")}</h3>
              {entries.map((entry) => {
                const thumbnail = channelLabels?.find((c) => c.channelId === entry.channelId)?.thumbnailUrl ?? null;
                return (
                  <div key={entry.key} className="flex items-start gap-2 rounded-lg border border-zinc-700 bg-zinc-950 p-2.5">
                    {thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumbnail} alt="" className="mt-0.5 h-7 w-7 shrink-0 rounded-full" />
                    ) : (
                      <div className="mt-0.5 h-7 w-7 shrink-0 rounded-full bg-zinc-700" />
                    )}
                    <div className="min-w-0 flex-1">
                      {/* ui-text-ignore: a channel's own name (data) */}
                      <p className="truncate text-xs font-medium text-zinc-100">{nameOf(entry.channelId)}</p>
                      <p className="text-xs text-zinc-300">{entry.text}</p>
                    </div>
                    {onOpenChannelWork && (
                      <button
                        onClick={() => {
                          setOpen(false);
                          onOpenChannelWork(entry.channelId, entry.href);
                        }}
                        className="shrink-0 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500"
                      >
                        {t("channelWork.open")}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">{t("shell.deviceSync")}</h3>
            <p className="mt-1 text-xs text-zinc-400">{status ? t(STATE_LABEL[status.state]) : t("common.loading")}</p>
            {status?.busyReason && status.state === "busy" && <p className="text-xs text-zinc-500">{status.busyReason}</p>}
            <p className="mt-1 text-xs text-zinc-500">
              {t("deviceSync.lastTimes", { published: formatTime(t, status?.lastExportAt ?? null), loaded: formatTime(t, status?.lastImportAt ?? null) })}
            </p>
            {status?.backgroundWritesPausedReason && (
              <p className="mt-1 text-xs text-amber-300">
                {t("deviceSync.researchWaiting", { reason: status.backgroundWritesPausedReason })}
              </p>
            )}
          </div>

          {notices.map((notice, index) => (
            <div key={`${notice.kind}-${index}`} className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-950 p-3">
              <p className="text-xs text-zinc-200">{notice.message}</p>
              {notice.kind === "divergence" && notice.snapshotId && (
                <>
                  {notice.createdAt && (
                    <p className="text-[11px] text-zinc-500">{t("deviceSync.otherDataFrom", { time: formatTime(t, notice.createdAt) })}</p>
                  )}
                  {onReviewDivergence && (
                    <button
                      onClick={() => {
                        setOpen(false);
                        onReviewDivergence();
                      }}
                      className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500"
                    >
                      {t("deviceSync.seeDifferences")}
                    </button>
                  )}
                </>
              )}
            </div>
          ))}

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex justify-end border-t border-zinc-800 pt-3">
            <button
              disabled={working || !status?.enabled}
              onClick={() => void post("/api/device-sync/sync-now")}
              className="rounded-md border border-zinc-600 px-3 py-1 text-xs font-medium text-zinc-200 hover:border-zinc-400 disabled:opacity-50"
            >
              {working ? t("common.syncing") : t("common.syncNow")}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
