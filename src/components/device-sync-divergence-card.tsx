"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";

/**
 * The snapshot-sync conflict, explained (owner, Telegram 2026-10-06, msg 1758: the bell asked to
 * choose, but the Merge tab showed no conflict and it was unclear what was being chosen between).
 * Shows both computers' versions -- since when they differ and, per section, what each one has that
 * the other does not -- and the only two ways to settle it (DEVICE_AUTO_SYNC_PLAN.md §3.6), each
 * saying what it would discard. The bell links here instead of offering the buttons itself.
 */

type Notice = { kind: string; message: string; snapshotId?: string; sourceDeviceId?: string; createdAt?: string };
type Status = { notices: Notice[] };
type Totals = { onlyHere: number; onlyThere: number; changed: number };
type Preview = {
  peer: { snapshotId: string; sourceDeviceId: string; createdAt: string; generation: number };
  local: { deviceId: string; headSnapshotId: string | null; lastExportAt: string | null; unpublishedChanges: boolean };
  commonBase: { snapshotId: string; createdAt: string; sourceDeviceId: string } | null;
  sections: Array<{ section: string } & Totals>;
  tables: Array<{ table: string; section: string } & Totals>;
};

const SECTION_HINT: Record<string, string> = {
  Batches: "prepared and executed Batches and their per-video rows",
  Audit: "the record of YouTube writes",
  Research: "Market Intelligence: research channels and their collected snapshots",
  Decisions: "hypotheses and experiments",
  Other: "other transferred data",
};

const POLL_MS = 30_000;

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toLocaleString();
}

const shortId = (id: string) => id.slice(0, 8);

function rowsLabel(n: number): string {
  return `${n} row${n === 1 ? "" : "s"}`;
}

export function DeviceSyncDivergenceCard() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [confirm, setConfirm] = useState<"keep_mine" | "take_theirs" | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/device-sync/status");
      if (!res.ok) return;
      const status = (await res.json()) as Status;
      const next = status.notices.find((n) => n.kind === "divergence" && n.snapshotId) ?? null;
      setNotice((prev) => (prev?.snapshotId === next?.snapshotId ? prev : next));
    } catch {
      // Non-fatal: keep the last known state until the next poll.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const snapshotId = notice?.snapshotId ?? null;
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!snapshotId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/device-sync/divergence?snapshotId=${encodeURIComponent(snapshotId)}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setPreviewError(data.message ?? `Error ${res.status}`);
        else setPreview(data as Preview);
      } catch (e) {
        if (!cancelled) setPreviewError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshotId]);

  async function resolve(choice: "keep_mine" | "take_theirs") {
    if (!snapshotId) return;
    setWorking(true);
    setError(null);
    try {
      const res = await fetch("/api/device-sync/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice, snapshotId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.message ?? data.error ?? `Error ${res.status}`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  }

  if (!notice) return null;

  const differing = preview?.sections.filter((s) => s.onlyHere + s.onlyThere + s.changed > 0) ?? [];
  const same = preview?.sections.filter((s) => s.onlyHere + s.onlyThere + s.changed === 0 && s.section !== "Other") ?? [];
  const lostIfKeep = preview?.sections.reduce((n, s) => n + s.onlyThere + s.changed, 0) ?? 0;
  const lostIfTake = preview?.sections.reduce((n, s) => n + s.onlyHere + s.changed, 0) ?? 0;

  return (
    <div className="rounded-xl border border-red-800 bg-red-950/20 p-4">
      <h2 className="text-lg font-semibold">Data differs between the two computers</h2>
      <p className="mt-1 text-sm text-zinc-300">
        This is the snapshot sync of Batches, the audit trail, Research and Decisions &mdash; whole copies, one
        history. Since the two computers last agreed, both changed this data, so one version has to be chosen.
        Change Sets, profiles and AI connections are not affected (their conflicts are listed below).
      </p>

      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-700 bg-zinc-950 p-3">
          <p className="font-medium text-zinc-100">This computer</p>
          <p className="text-xs text-zinc-400">
            device {preview ? shortId(preview.local.deviceId) : "…"}
            {preview?.local.lastExportAt ? ` · last published ${formatTime(preview.local.lastExportAt)}` : ""}
          </p>
          {preview?.local.unpublishedChanges && <p className="text-xs text-amber-300">Has changes not published yet.</p>}
        </div>
        <div className="rounded-lg border border-zinc-700 bg-zinc-950 p-3">
          <p className="font-medium text-zinc-100">The other computer</p>
          <p className="text-xs text-zinc-400">
            device {shortId(notice.sourceDeviceId ?? preview?.peer.sourceDeviceId ?? "unknown")} · published{" "}
            {formatTime(notice.createdAt ?? preview?.peer.createdAt)}
          </p>
        </div>
      </div>
      {preview?.commonBase && (
        <p className="mt-2 text-xs text-zinc-400">
          Both continue from the version of {formatTime(preview.commonBase.createdAt)}; everything below changed after it.
        </p>
      )}

      <div className="mt-3">
        {!preview && !previewError && <p className="text-sm text-zinc-400">Comparing the two versions...</p>}
        {previewError && <p className="text-sm text-red-300">Could not compare the two versions: {previewError}</p>}
        {preview && differing.length === 0 && (
          <p className="text-sm text-zinc-300">The two versions now hold the same data; this resolves itself on the next sync.</p>
        )}
        {preview && differing.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-400">
              <tr>
                <th className="py-1 pr-3 font-medium">Section</th>
                <th className="py-1 pr-3 font-medium">Only on this computer</th>
                <th className="py-1 pr-3 font-medium">Only on the other</th>
                <th className="py-1 font-medium">On both, but different</th>
              </tr>
            </thead>
            <tbody>
              {differing.map((s) => (
                <tr key={s.section} className="border-t border-zinc-800 align-top">
                  <td className="py-1.5 pr-3">
                    <p className="text-zinc-100">{s.section}</p>
                    <p className="text-xs text-zinc-500">{SECTION_HINT[s.section] ?? ""}</p>
                    <p className="font-mono text-[11px] text-zinc-500">
                      {preview.tables
                        .filter((t) => t.section === s.section)
                        .map((t) => `${t.table}: +${t.onlyHere} here / +${t.onlyThere} there / ${t.changed} changed`)
                        .join(" · ")}
                    </p>
                  </td>
                  <td className="py-1.5 pr-3 text-zinc-200">{rowsLabel(s.onlyHere)}</td>
                  <td className="py-1.5 pr-3 text-zinc-200">{rowsLabel(s.onlyThere)}</td>
                  <td className="py-1.5 text-zinc-200">{rowsLabel(s.changed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {preview && same.length > 0 && (
          <p className="mt-2 text-xs text-zinc-400">Identical on both computers: {same.map((s) => s.section).join(", ")}.</p>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <button
            disabled={working}
            onClick={() => setConfirm("keep_mine")}
            className="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Keep this computer&apos;s data
          </button>
          <p className="text-xs text-zinc-400">
            The other computer switches to this version.
            {preview ? ` It loses ${rowsLabel(lostIfKeep)} (kept there in a backup).` : ""}
          </p>
        </div>
        <div className="space-y-2">
          <button
            disabled={working}
            onClick={() => setConfirm("take_theirs")}
            className="w-full rounded-md border border-zinc-600 px-3 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-400 disabled:opacity-50"
          >
            Take the other computer&apos;s data
          </button>
          <p className="text-xs text-zinc-400">
            This computer switches to the other version.
            {preview ? ` It loses ${rowsLabel(lostIfTake)} (a backup is saved first).` : ""}
          </p>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm === "keep_mine" ? "Keep this computer's data?" : "Take the other computer's data?"}
          description={
            confirm === "keep_mine"
              ? `This computer's Batches, audit trail, Research and Decisions data will replace the other computer's the next time it syncs.${preview ? ` The other computer loses ${rowsLabel(lostIfKeep)} listed above; they stay in a backup there.` : ""}`
              : `This computer's Batches, audit trail, Research and Decisions data will be replaced by the other computer's.${preview ? ` This computer loses ${rowsLabel(lostIfTake)} listed above.` : ""} A backup of this computer's current data is saved first.`
          }
          confirmLabel={confirm === "keep_mine" ? "Keep mine" : "Take theirs"}
          confirmVariant="danger"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const choice = confirm;
            setConfirm(null);
            void resolve(choice);
          }}
        />
      )}
    </div>
  );
}
