"use client";

import { errorText } from "@/lib/ui-text";
import { useCallback, useEffect, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import type { Translate, UiTextKey } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { useT } from "./ui-text-provider";

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
  peerTips: number;
  commonBase: { snapshotId: string; createdAt: string; sourceDeviceId: string } | null;
  sections: Array<{ section: string } & Totals>;
  tables: Array<{ table: string; section: string } & Totals>;
};

/** Section ids come from the server (`s.section`); known ones get a translated name and hint, an unknown one shows as is. */
const SECTION_NAME: Record<string, UiTextKey> = {
  Batches: "divergence.section.batches",
  Audit: "divergence.section.audit",
  Research: "divergence.section.research",
  Decisions: "divergence.section.decisions",
  Other: "divergence.section.other",
};

const SECTION_HINT: Record<string, UiTextKey> = {
  Batches: "divergence.sectionHint.batches",
  Audit: "divergence.sectionHint.audit",
  Research: "divergence.sectionHint.research",
  Decisions: "divergence.sectionHint.decisions",
  Other: "divergence.sectionHint.other",
};

function sectionName(t: Translate, section: string): string {
  return SECTION_NAME[section] ? t(SECTION_NAME[section]) : section;
}

const POLL_MS = 30_000;

function formatTime(t: Translate, iso: string | null | undefined): string {
  if (!iso) return t("divergence.unknownTime");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? t("divergence.unknownTime") : formatDisplayDateTime(date);
}

const shortId = (id: string) => id.slice(0, 8);

export function DeviceSyncDivergenceCard() {
  const t = useT();
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
  const loadPreview = useCallback(async (id: string): Promise<Preview | null> => {
    try {
      const res = await fetch(`/api/device-sync/divergence?snapshotId=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPreviewError(errorText(t, data, t("common.errorStatus", { status: String(res.status) }), { showErrorField: false }));
        return null;
      }
      setPreviewError(null);
      setPreview(data as Preview);
      return data as Preview;
    } catch (e) {
      setPreviewError(String(e));
      return null;
    }
  }, [t]);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (snapshotId) void loadPreview(snapshotId);
  }, [snapshotId, loadPreview]);

  /** The numbers in the confirm dialog come from a fresh comparison, made when it opens: data may
   * have changed since the card was first drawn (review round 1, #6). */
  async function openConfirm(choice: "keep_mine" | "take_theirs") {
    if (!snapshotId) return;
    setWorking(true);
    const fresh = await loadPreview(snapshotId);
    setWorking(false);
    if (fresh) setConfirm(choice);
  }

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
      if (!res.ok) setError(errorText(t, data, t("common.errorStatus", { status: String(res.status) })));
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
      <h2 className="text-lg font-semibold">{t("divergence.title")}</h2>
      <p className="mt-1 text-sm text-zinc-300">{t("divergence.intro")}</p>

      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-700 bg-zinc-950 p-3">
          <p className="font-medium text-zinc-100">{t("divergence.thisComputer")}</p>
          <p className="text-xs text-zinc-400">
            {t("divergence.device", { id: preview ? shortId(preview.local.deviceId) : "…" })}
            {preview?.local.lastExportAt
              ? ` · ${t("divergence.lastPublished", { time: formatTime(t, preview.local.lastExportAt) })}`
              : ""}
          </p>
          {preview?.local.unpublishedChanges && <p className="text-xs text-amber-300">{t("divergence.unpublished")}</p>}
        </div>
        <div className="rounded-lg border border-zinc-700 bg-zinc-950 p-3">
          <p className="font-medium text-zinc-100">{t("divergence.otherComputer")}</p>
          <p className="text-xs text-zinc-400">
            {t("divergence.device", {
              id: (() => {
                const peerDevice = notice.sourceDeviceId ?? preview?.peer.sourceDeviceId;
                return peerDevice ? shortId(peerDevice) : t("divergence.unknownDevice");
              })(),
            })}{" "}
            · {t("divergence.published", { time: formatTime(t, notice.createdAt ?? preview?.peer.createdAt) })}
          </p>
        </div>
      </div>
      {preview?.commonBase && (
        <p className="mt-2 text-xs text-zinc-400">
          {t("divergence.commonBase", { time: formatTime(t, preview.commonBase.createdAt) })}
        </p>
      )}

      <div className="mt-3">
        {!preview && !previewError && <p className="text-sm text-zinc-400">{t("divergence.comparing")}</p>}
        {previewError && <p className="text-sm text-red-300">{t("divergence.compareFailed", { error: previewError })}</p>}
        {preview && differing.length === 0 && preview.peerTips === 1 && (
          <p className="text-sm text-zinc-300">{t("divergence.nowSame")}</p>
        )}
        {preview && preview.peerTips > 1 && (
          <p className="text-sm text-amber-300">{t("divergence.manyTips", { count: preview.peerTips })}</p>
        )}
        {preview && differing.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-400">
              <tr>
                <th className="py-1 pr-3 font-medium">{t("divergence.column.section")}</th>
                <th className="py-1 pr-3 font-medium">{t("divergence.column.onlyHere")}</th>
                <th className="py-1 pr-3 font-medium">{t("divergence.column.onlyThere")}</th>
                <th className="py-1 font-medium">{t("divergence.column.changed")}</th>
              </tr>
            </thead>
            <tbody>
              {differing.map((s) => (
                <tr key={s.section} className="border-t border-zinc-800 align-top">
                  <td className="py-1.5 pr-3">
                    <p className="text-zinc-100">{sectionName(t, s.section)}</p>
                    <p className="text-xs text-zinc-500">{SECTION_HINT[s.section] ? t(SECTION_HINT[s.section]) : ""}</p>
                    <p className="font-mono text-[11px] text-zinc-500">
                      {preview.tables
                        .filter((table) => table.section === s.section)
                        .map((table) =>
                          t("divergence.tableCounts", {
                            table: table.table,
                            here: table.onlyHere,
                            there: table.onlyThere,
                            changed: table.changed,
                          })
                        )
                        .join(" · ")}
                    </p>
                  </td>
                  <td className="py-1.5 pr-3 text-zinc-200">{t("divergence.rows", { count: s.onlyHere })}</td>
                  <td className="py-1.5 pr-3 text-zinc-200">{t("divergence.rows", { count: s.onlyThere })}</td>
                  <td className="py-1.5 text-zinc-200">{t("divergence.rows", { count: s.changed })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {preview && same.length > 0 && (
          <p className="mt-2 text-xs text-zinc-400">
            {t("divergence.identical", { sections: same.map((s) => sectionName(t, s.section)).join(", ") })}
          </p>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <button
            disabled={working}
            onClick={() => void openConfirm("keep_mine")}
            className="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {t("divergence.keepMine")}
          </button>
          <p className="text-xs text-zinc-400">
            {preview ? t("divergence.keepMineHintLoses", { count: lostIfKeep }) : t("divergence.keepMineHint")}
          </p>
        </div>
        <div className="space-y-2">
          <button
            disabled={working}
            onClick={() => void openConfirm("take_theirs")}
            className="w-full rounded-md border border-zinc-600 px-3 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-400 disabled:opacity-50"
          >
            {t("divergence.takeTheirs")}
          </button>
          <p className="text-xs text-zinc-400">
            {preview ? t("divergence.takeTheirsHintLoses", { count: lostIfTake }) : t("divergence.takeTheirsHint")}
          </p>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm === "keep_mine" ? t("divergence.confirmKeep.title") : t("divergence.confirmTake.title")}
          description={
            confirm === "keep_mine"
              ? preview
                ? t("divergence.confirmKeep.bodyLoses", { count: lostIfKeep })
                : t("divergence.confirmKeep.body")
              : preview
                ? t("divergence.confirmTake.bodyLoses", { count: lostIfTake })
                : t("divergence.confirmTake.body")
          }
          confirmLabel={confirm === "keep_mine" ? t("divergence.confirmKeep.confirm") : t("divergence.confirmTake.confirm")}
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
