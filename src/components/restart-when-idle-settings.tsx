"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { useT } from "./ui-text-provider";

// BL-220 (docs/roadmap/plans/RESTART_WHEN_IDLE_PLAN.md, ADR 0049): Settings → О программе, «Перезапуск, когда никто не работает».
// The owner's button (after a confirmation), the open request with what it waits for (polled every 5 s while open), its cancel, the
// holds (who / why / until, each with «Снять»), the MCP quiet minutes and the last restart. Every text is a ui-text key.

type Reason = { kind: string; count: number; ids: string[]; until: string | null };
type RequestView = { id: string; status: "open" | "restarting" | "done" | "cancelled" | "expired"; requestedBy: "owner" | "developer"; requestedAt: string; restartingAt: string | null; finishedAt: string | null; waitedMinutes: number | null; fromVersion: string | null; toVersion: string | null };
type HoldView = { holdId: string; heldBy: string; reason: string; until: string; active: boolean };
type Status = { request: RequestView | null; waitingFor: Reason[]; holds: HoldView[]; lastRestart: RequestView | null; quietMinutes: number; serviceMode: boolean };

const POLL_MS = 5_000;
const REASON_KEYS: Record<string, UiTextKey> = {
  media_session: "settingsCards.restartIdle.reason.media_session",
  media_job: "settingsCards.restartIdle.reason.media_job",
  gemini_job: "settingsCards.restartIdle.reason.gemini_job",
  upload: "settingsCards.restartIdle.reason.upload",
  live_stream: "settingsCards.restartIdle.reason.live_stream",
  operation_lock: "settingsCards.restartIdle.reason.operation_lock",
  operation: "settingsCards.restartIdle.reason.operation",
  batch: "settingsCards.restartIdle.reason.batch",
  hold: "settingsCards.restartIdle.reason.hold",
  mcp_quiet: "settingsCards.restartIdle.reason.mcp_quiet",
  check_failed: "settingsCards.restartIdle.reason.check_failed",
};

function parseQuiet(draft: string): number | null {
  if (!/^\d{1,2}$/.test(draft.trim())) return null;
  const value = Number(draft.trim());
  return value >= 1 && value <= 30 ? value : null;
}

export function RestartWhenIdleSettings() {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quietDraft, setQuietDraft] = useState("3");
  const [savedNotice, setSavedNotice] = useState(false);
  // The stored value last shown in the field: a poll refreshes the field only when the stored value itself changed.
  const loadedQuiet = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/restart-when-idle", { cache: "no-store" });
      if (!res.ok) {
        setLoadError(t("settings.loadFailed"));
        return;
      }
      const data = (await res.json()) as Status;
      setLoadError(null);
      setUnreachable(false);
      if (loadedQuiet.current !== data.quietMinutes) {
        loadedQuiet.current = data.quietMinutes;
        setQuietDraft(String(data.quietMinutes));
      }
      setStatus(data);
    } catch {
      // While a restart is under way the server does not answer: keep polling, say so.
      setUnreachable(true);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = status?.request !== null && status?.request !== undefined;
  useEffect(() => {
    if (!open && !unreachable) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, unreachable, load]);

  async function act(input: RequestInfo, init: RequestInit, onDone?: () => void) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(input, init);
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(errorText(t, data, t("settings.saveFailed"), { showErrorField: false }));
        return;
      }
      onDone?.();
      await load();
    } catch {
      setError(t("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const who = (by: string) => (by === "developer" ? t("settingsCards.restartIdle.by.developer") : t("settingsCards.restartIdle.by.owner"));
  const holder = (heldBy: string) =>
    heldBy === "factory"
      ? t("settingsCards.restartIdle.holdBy.factory")
      : heldBy === "owner"
        ? t("settingsCards.restartIdle.holdBy.owner")
        : t("settingsCards.restartIdle.holdBy.worker", { channel: heldBy.replace(/^worker:/, "") });

  if (!status) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {loadError || unreachable ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-400">{unreachable ? t("settingsCards.restartIdle.unreachable") : loadError}</p>
            <button onClick={() => void load()} className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800">
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <LoadingIndicator className="text-sm text-zinc-400" />
        )}
      </div>
    );
  }

  const quiet = parseQuiet(quietDraft);
  const quietDirty = quiet !== null && quiet !== status.quietMinutes;
  const request = status.request;
  const last = status.lastRestart;

  // The stop was sent 5+ minutes ago and the server still answers: the restart did not happen; the owner may cancel it.
  const stuck = request?.status === "restarting" && request.restartingAt !== null && Date.now() - Date.parse(request.restartingAt) >= 5 * 60_000;
  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t("settingsCards.restartIdle.title")}
        <InfoTooltip>{t("settingsCards.restartIdle.info")}</InfoTooltip>
      </h3>

      {unreachable && <p className="text-sm text-amber-300">{t("settingsCards.restartIdle.unreachable")}</p>}

      {!request && (
        <div className="space-y-1">
          <button
            onClick={() => setConfirming(true)}
            disabled={busy || !status.serviceMode}
            className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {t("settingsCards.restartIdle.button")}
          </button>
          {!status.serviceMode && <p className="text-xs text-zinc-400">{t("settingsCards.restartIdle.needsService")}</p>}
        </div>
      )}

      {request && (
        <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-sm">
          <p className="text-zinc-200">{t("settingsCards.restartIdle.requested", { time: formatDisplayDateTime(request.requestedAt), who: who(request.requestedBy) })}</p>
          {request.status === "restarting" ? (
            <p className="text-amber-300">
              {stuck ? t("settingsCards.restartIdle.stuck") : t("settingsCards.restartIdle.restarting")}
            </p>
          ) : status.waitingFor.length === 0 ? (
            <p className="text-emerald-400">{t("settingsCards.restartIdle.nothingWaiting")}</p>
          ) : (
            <div>
              <p className="text-zinc-400">{t("settingsCards.restartIdle.waitingTitle")}</p>
              <ul className="ml-4 list-disc text-zinc-200">
                {status.waitingFor.map((reason) => (
                  <li key={reason.kind}>
                    {t(REASON_KEYS[reason.kind] ?? "settingsCards.restartIdle.reason.check_failed", { count: reason.count })}
                    {reason.until && <span className="text-zinc-400"> ({t("settingsCards.restartIdle.until", { time: formatDisplayDateTime(reason.until) })})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(request.status === "open" || stuck) && (
            <button
              onClick={() => void act("/api/restart-when-idle", { method: "DELETE" })}
              disabled={busy}
              className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              {t("settingsCards.restartIdle.cancel")}
            </button>
          )}
        </div>
      )}

      <div className="space-y-1">
        <p className="text-sm font-medium text-zinc-200">{t("settingsCards.restartIdle.holdsTitle")}</p>
        {status.holds.length === 0 ? (
          <p className="text-xs text-zinc-400">{t("settingsCards.restartIdle.noHolds")}</p>
        ) : (
          <ul className="space-y-1">
            {status.holds.map((hold) => (
              <li key={hold.holdId} className="flex flex-wrap items-center gap-2 text-sm text-zinc-200">
                <span className="font-medium">{holder(hold.heldBy)}</span>
                <span className="text-zinc-300">{hold.reason}</span>
                <span className="text-xs text-zinc-400">{t("settingsCards.restartIdle.until", { time: formatDisplayDateTime(hold.until) })}</span>
                <button
                  onClick={() => void act(`/api/restart-when-idle/holds/${encodeURIComponent(hold.holdId)}`, { method: "DELETE" })}
                  disabled={busy}
                  className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {t("settingsCards.restartIdle.release")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          inputMode="numeric"
          value={quietDraft}
          onChange={(e) => {
            setQuietDraft(e.target.value);
            setSavedNotice(false);
          }}
          disabled={busy}
          aria-label={t("settingsCards.restartIdle.quietAria")}
          className="w-16 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50"
        />
        <span className="text-sm text-zinc-400">{t("settingsCards.restartIdle.quietLabel")}</span>
        <button
          onClick={() =>
            void act(
              "/api/restart-when-idle/settings",
              { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ quietMinutes: quiet }) },
              () => setSavedNotice(true)
            )
          }
          disabled={busy || !quietDirty}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </div>
      {quiet === null && <p className="text-xs text-red-400">{t("settingsCards.restartIdle.quietInvalid")}</p>}
      {savedNotice && !quietDirty && <p className="text-xs text-emerald-400">{t("common.saved")}</p>}

      <p className="text-xs text-zinc-400">
        {last && last.finishedAt
          ? t("settingsCards.restartIdle.lastRestart", {
              time: formatDisplayDateTime(last.finishedAt),
              from: last.fromVersion ?? "?",
              to: last.toVersion ?? "?",
              minutes: last.waitedMinutes ?? 0,
              who: who(last.requestedBy),
            })
          : t("settingsCards.restartIdle.noLastRestart")}
      </p>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {confirming && (
        <ConfirmDialog
          title={t("settingsCards.restartIdle.confirmTitle")}
          description={t("settingsCards.restartIdle.confirmBody")}
          confirmLabel={t("settingsCards.restartIdle.confirm")}
          confirmVariant="danger"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void act("/api/restart-when-idle", { method: "POST" });
          }}
        />
      )}
    </div>
  );
}
