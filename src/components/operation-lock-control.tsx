"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OperationLockStatus } from "@/lib/operation-lock/contracts";
import { OPERATION_LOCK_FORCE_CONFIRMATION } from "@/lib/operation-lock/contracts";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import type { Translate, UiTextKey } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";

type DatabaseState = "ready" | "failed" | "starting";
type LockResponse = { status: OperationLockStatus | null; database: DatabaseState };

const POLL_MS = 3_000;

const OPERATION_LABELS: Record<string, UiTextKey> = {
  migration: "operationLock.op.migration",
  import: "operationLock.op.import",
  export: "operationLock.op.export",
};

function formatElapsed(t: Translate, ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return t("duration.seconds", { s: totalSeconds });
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return t("duration.minutesSeconds", { m: minutes, s: totalSeconds % 60 });
  return t("duration.hoursMinutes", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

/**
 * Shows the device-wide operation lock (export/import/schema migration) and lets the operator
 * clear a stuck one without touching code or the database file. Used by the /recovery page (which
 * works when the app could not finish starting) and by the Merge tab. Clearing is always an
 * explicit click: nothing here, or anywhere else, releases a migration/import lock automatically.
 * A lock whose holder process is gone is cleared with one click; one that still looks alive
 * needs the force flow (typed confirmation), because it may be a genuinely running operation or a
 * dead holder whose PID the OS has since handed to an unrelated process.
 */
export function OperationLockControl({
  onChanged,
  quiet = false,
}: {
  onChanged?: () => void;
  /** Render nothing unless something needs attention: no lock, or a live export (which takes about
   * a second and runs about once a minute under automatic sync) stays invisible. */
  quiet?: boolean;
}) {
  const t = useT();
  const [data, setData] = useState<LockResponse | null>(null);
  // `detail` is the HTTP status when the server answered with an error; null for any other failure (shown as the plain
  // translated "could not read" text instead of a browser's own English error message).
  const [loadError, setLoadError] = useState<{ detail: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [forceOpen, setForceOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/operation-lock", { cache: "no-store" });
      if (!response.ok) {
        // ui-text-ignore: an HTTP status code, shown as the detail of the translated sentence
        setLoadError({ detail: `HTTP ${response.status}` });
        return;
      }
      setData((await response.json()) as LockResponse);
      setFetchedAt(Date.now());
      setLoadError(null);
    } catch {
      setLoadError({ detail: null });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [refresh]);

  const status = data?.status ?? null;

  // Tell the host when a lock it was showing has gone (finished or cleared), so it can refresh the
  // controls that were disabled while the lock was held.
  const hadLock = useRef(false);
  useEffect(() => {
    if (status) hadLock.current = true;
    else if (hadLock.current) {
      hadLock.current = false;
      onChanged?.();
    }
  }, [status, onChanged]);

  async function clearLock(force: boolean) {
    if (!status) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operation-lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationType: status.lock.operationType,
          holderPid: status.lock.holderPid,
          acquiredAt: status.lock.acquiredAt,
          force,
          confirmation: force ? confirmation : undefined,
        }),
      });
      const result = (await response.json()) as { outcome?: string; error?: string };
      if (result.outcome === "cleared") setMessage(t("operationLock.result.cleared"));
      else if (result.outcome === "not_held") setMessage(t("operationLock.result.notHeld"));
      else if (result.outcome === "changed") setMessage(t("operationLock.result.changed"));
      else if (result.outcome === "holder_alive") setMessage(t("operationLock.result.holderAlive"));
      else setMessage(result.error ?? t("operationLock.result.failed"));
      setForceOpen(false);
      setConfirmation("");
      await refresh();
      onChanged?.();
    } catch {
      setMessage(t("operationLock.result.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (loadError && !data) {
    return <p className="text-sm text-red-300">{loadError.detail ? t("operationLock.loadError", { error: loadError.detail }) : t("operationLock.loadFailed")}</p>;
  }
  if (!data) return <p className="text-sm text-zinc-500">{t("operationLock.checking")}</p>;

  const databaseNote =
    data.database === "ready"
      ? t("operationLock.db.ready")
      : data.database === "starting"
        ? t("operationLock.db.starting")
        : t("operationLock.db.failed");

  if (quiet && (!status || (status.lock.operationType === "export" && !status.stale))) return null;

  if (!status) {
    return (
      <div className="space-y-1 text-sm">
        <p className="text-green-300">{t("operationLock.none")}</p>
        <p className="text-zinc-400">{databaseNote}</p>
        {message && <p className="text-zinc-300">{message}</p>}
      </div>
    );
  }

  const elapsed = status.elapsedMs + Math.max(0, now - fetchedAt);
  const labelKey = OPERATION_LABELS[status.lock.operationType];
  const label = labelKey ? t(labelKey) : status.lock.operationType;

  return (
    <div
      className={`space-y-3 rounded-lg border px-4 py-3 text-sm ${
        status.stale ? "border-amber-700 bg-amber-950/40 text-amber-100" : "border-blue-800 bg-blue-950/40 text-blue-200"
      }`}
    >
      <div>
        <p className="font-medium">
          {t(status.stale ? "operationLock.interrupted" : "operationLock.inProgress", { operation: label })}
        </p>
        <p className="mt-1 text-xs opacity-80">
          {t(status.holderAlive ? "operationLock.startedRunning" : "operationLock.startedStopped", {
            time: formatDisplayDateTime(status.lock.acquiredAt),
            elapsed: formatElapsed(t, elapsed),
            pid: String(status.lock.holderPid),
          })}
        </p>
      </div>
      <p>
        {status.stale
          ? t("operationLock.staleBody")
          : status.lock.operationType === "migration"
            ? t("operationLock.migrationBody")
            : t("operationLock.otherBody")}
      </p>
      <p className="text-xs opacity-80">{databaseNote}</p>

      <div className="flex flex-wrap items-center gap-2">
        {status.stale ? (
          <button
            onClick={() => void clearLock(false)}
            disabled={busy}
            className="rounded-md border border-amber-500 px-3 py-1.5 text-xs font-medium hover:bg-amber-900/40 disabled:opacity-50"
          >
            {busy ? t("operationLock.clearing") : t("operationLock.clear")}
          </button>
        ) : (
          <button
            onClick={() => setForceOpen((open) => !open)}
            className="rounded-md border border-zinc-600 px-3 py-1.5 text-xs font-medium hover:bg-zinc-800"
          >
            {t("operationLock.looksStuck")}
          </button>
        )}
      </div>

      {forceOpen && !status.stale && (
        <div className="space-y-2 rounded-md border border-red-800 bg-red-950/40 p-3 text-xs text-red-200">
          <p>{t("operationLock.forceWarning", { word: OPERATION_LOCK_FORCE_CONFIRMATION })}</p>
          <div className="flex items-center gap-2">
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className="w-28 rounded border border-red-700 bg-zinc-950 px-2 py-1 text-zinc-100"
              aria-label={t("operationLock.typeToConfirm", { word: OPERATION_LOCK_FORCE_CONFIRMATION })}
            />
            <button
              onClick={() => void clearLock(true)}
              disabled={busy || confirmation !== OPERATION_LOCK_FORCE_CONFIRMATION}
              className="rounded-md border border-red-600 px-3 py-1 font-medium hover:bg-red-900/40 disabled:opacity-50"
            >
              {t("operationLock.forceClear")}
            </button>
          </div>
        </div>
      )}
      {message && <p className="text-xs">{message}</p>}
    </div>
  );
}
