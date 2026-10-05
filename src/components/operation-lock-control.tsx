"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OperationLockStatus } from "@/lib/operation-lock/contracts";
import { OPERATION_LOCK_FORCE_CONFIRMATION } from "@/lib/operation-lock/contracts";

type DatabaseState = "ready" | "failed" | "starting";
type LockResponse = { status: OperationLockStatus | null; database: DatabaseState };

const POLL_MS = 3_000;

const OPERATION_LABELS: Record<string, string> = {
  migration: "Database schema migration",
  import: "Handoff import",
  export: "Handoff export",
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min ${totalSeconds % 60}s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
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
  const [data, setData] = useState<LockResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [forceOpen, setForceOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/operation-lock", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData((await response.json()) as LockResponse);
      setFetchedAt(Date.now());
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not read the lock state.");
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
      if (result.outcome === "cleared") setMessage("Lock cleared.");
      else if (result.outcome === "not_held") setMessage("The lock was already released.");
      else if (result.outcome === "changed") setMessage("The lock changed while you were looking at it -- review the new state.");
      else if (result.outcome === "holder_alive") setMessage("The holder process is still running -- use the force option only if you are sure it is stuck.");
      else setMessage(result.error ?? "Could not clear the lock.");
      setForceOpen(false);
      setConfirmation("");
      await refresh();
      onChanged?.();
    } catch {
      setMessage("Could not clear the lock.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError && !data) {
    return <p className="text-sm text-red-300">Could not read the operation lock state ({loadError}).</p>;
  }
  if (!data) return <p className="text-sm text-zinc-500">Checking operation lock...</p>;

  const databaseNote =
    data.database === "ready"
      ? "Database: ready."
      : data.database === "starting"
        ? "Database: still starting up..."
        : "Database: not initialized yet (it retries automatically once the lock is gone).";

  if (quiet && (!status || (status.lock.operationType === "export" && !status.stale))) return null;

  if (!status) {
    return (
      <div className="space-y-1 text-sm">
        <p className="text-green-300">No operation is holding the device lock.</p>
        <p className="text-zinc-400">{databaseNote}</p>
        {message && <p className="text-zinc-300">{message}</p>}
      </div>
    );
  }

  const elapsed = status.elapsedMs + Math.max(0, now - fetchedAt);
  const label = OPERATION_LABELS[status.lock.operationType] ?? status.lock.operationType;

  return (
    <div
      className={`space-y-3 rounded-lg border px-4 py-3 text-sm ${
        status.stale ? "border-amber-700 bg-amber-950/40 text-amber-100" : "border-blue-800 bg-blue-950/40 text-blue-200"
      }`}
    >
      <div>
        <p className="font-medium">
          {label} {status.stale ? "was interrupted" : "is in progress"}
        </p>
        <p className="mt-1 text-xs opacity-80">
          Started {status.lock.acquiredAt} ({formatElapsed(elapsed)} ago) &middot; process {status.lock.holderPid}{" "}
          {status.holderAlive ? "is running" : "is no longer running"}
        </p>
      </div>
      <p>
        {status.stale
          ? "The process that held this lock has stopped (closed window, restart or crash) and will never release it. Nothing is running now. Your data is intact (a pre-migration backup is kept); the interrupted operation is simply re-run on the next start."
          : status.lock.operationType === "migration"
            ? "A schema migration normally takes a few seconds. This page refreshes on its own and the app continues when it finishes."
            : "This usually finishes within seconds. This page refreshes on its own."}
      </p>
      <p className="text-xs opacity-80">{databaseNote}</p>

      <div className="flex flex-wrap items-center gap-2">
        {status.stale ? (
          <button
            onClick={() => void clearLock(false)}
            disabled={busy}
            className="rounded-md border border-amber-500 px-3 py-1.5 text-xs font-medium hover:bg-amber-900/40 disabled:opacity-50"
          >
            {busy ? "Clearing..." : "Clear interrupted lock"}
          </button>
        ) : (
          <button
            onClick={() => setForceOpen((open) => !open)}
            className="rounded-md border border-zinc-600 px-3 py-1.5 text-xs font-medium hover:bg-zinc-800"
          >
            Looks stuck? Force clear...
          </button>
        )}
      </div>

      {forceOpen && !status.stale && (
        <div className="space-y-2 rounded-md border border-red-800 bg-red-950/40 p-3 text-xs text-red-200">
          <p>
            The holder process still appears to be running. Clearing the lock under a live operation can corrupt
            it. Do this only if you are sure nothing is running (for example the process id was reused by an
            unrelated program). Type {OPERATION_LOCK_FORCE_CONFIRMATION} to confirm.
          </p>
          <div className="flex items-center gap-2">
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className="w-28 rounded border border-red-700 bg-zinc-950 px-2 py-1 text-zinc-100"
              aria-label={`Type ${OPERATION_LOCK_FORCE_CONFIRMATION} to confirm`}
            />
            <button
              onClick={() => void clearLock(true)}
              disabled={busy || confirmation !== OPERATION_LOCK_FORCE_CONFIRMATION}
              className="rounded-md border border-red-600 px-3 py-1 font-medium hover:bg-red-900/40 disabled:opacity-50"
            >
              Force clear
            </button>
          </div>
        </div>
      )}
      {message && <p className="text-xs">{message}</p>}
    </div>
  );
}
