"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";

/**
 * Automatic device sync notifications (docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md §3.7): a bell in
 * the header showing what the server-side sync last did, and anything that needs a human --
 * above all a divergence (both computers changed data), resolved only by an explicit choice here.
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
};

const POLL_MS = 30_000;

const STATE_LABEL: Record<SyncStatus["state"], string> = {
  disabled: "Automatic sync is off (Settings → Sync)",
  not_configured: "No sync folder is configured (Settings → Sync)",
  folder_unreachable: "The sync folder is not reachable — is the drive connected? Paused until it is.",
  busy: "Paused while another operation runs",
  synced: "Up to date",
  exported: "Published this computer's changes",
  imported: "Loaded the other computer's changes",
  waiting: "Waiting (Syncthing transfer or the next export window)",
  attention: "Needs your attention",
};

function formatTime(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "never" : date.toLocaleString();
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0v1a3 3 0 1 1-6 0v-1m6 0H9" />
    </svg>
  );
}

export function DeviceSyncBell() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ choice: "keep_mine" | "take_theirs"; snapshotId: string } | null>(null);
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
      if (confirm) return;
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, confirm]);

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
        setError(data.message ?? data.error ?? `Error ${res.status}`);
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
      : null;

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Device sync notifications"
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted transition-colors hover:border-accent hover:text-white"
      >
        <BellIcon />
        {dotClass && <span className={`absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full ${dotClass}`} />}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-96 space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Device sync</h3>
            <p className="mt-1 text-xs text-zinc-400">{status ? STATE_LABEL[status.state] : "Loading..."}</p>
            {status?.busyReason && status.state === "busy" && <p className="text-xs text-zinc-500">{status.busyReason}</p>}
            <p className="mt-1 text-xs text-zinc-500">
              Last published: {formatTime(status?.lastExportAt ?? null)} · Last loaded: {formatTime(status?.lastImportAt ?? null)}
            </p>
          </div>

          {notices.map((notice, index) => (
            <div key={`${notice.kind}-${index}`} className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-950 p-3">
              <p className="text-xs text-zinc-200">{notice.message}</p>
              {notice.kind === "divergence" && notice.snapshotId && (
                <>
                  {notice.createdAt && (
                    <p className="text-[11px] text-zinc-500">Other computer&apos;s data from {formatTime(notice.createdAt)}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      disabled={working}
                      onClick={() => setConfirm({ choice: "keep_mine", snapshotId: notice.snapshotId! })}
                      className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      Keep this computer&apos;s data
                    </button>
                    <button
                      disabled={working}
                      onClick={() => setConfirm({ choice: "take_theirs", snapshotId: notice.snapshotId! })}
                      className="rounded-md border border-zinc-600 px-3 py-1 text-xs font-medium text-zinc-200 hover:border-zinc-400 disabled:opacity-50"
                    >
                      Take the other computer&apos;s data
                    </button>
                  </div>
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
              {working ? "Syncing..." : "Sync now"}
            </button>
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.choice === "keep_mine" ? "Keep this computer's data?" : "Take the other computer's data?"}
          description={
            confirm.choice === "keep_mine"
              ? "This computer's Batches history, audit trail, Research and Decisions data will be published and will replace the other computer's version of that data the next time it syncs. The other computer's changes since the last sync will be lost there."
              : "This computer's Batches history, audit trail, Research and Decisions data will be replaced by the other computer's version. A backup of this computer's current data is saved first. Changes made here since the last sync will no longer be in the app."
          }
          confirmLabel={confirm.choice === "keep_mine" ? "Keep mine" : "Take theirs"}
          confirmVariant="danger"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { choice, snapshotId } = confirm;
            setConfirm(null);
            void post("/api/device-sync/resolve", { choice, snapshotId });
          }}
        />
      )}
    </div>
  );
}
