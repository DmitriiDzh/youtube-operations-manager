"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";

type UnresolvedRow = { batchId: string; ledgerRowId: string; videoId: string; status: string };

type StatusResponse = {
  lock: { operationType: string; holderPid: number; acquiredAt: string } | null;
  recoveryMode: boolean;
  unresolved: UnresolvedRow[];
  lineage: { lastSnapshotId: string | null; lastGeneration: number };
};

type SnapshotSummary = {
  snapshotId: string;
  parentSnapshotId: string | null;
  sourceDeviceId: string;
  generation: number;
  createdAt: string;
};

/** Mirrors `FieldConflict` (src/lib/change-drafts/contracts.ts) -- kept as a local structural
 * type rather than importing a server-only module into a client component. */
type FieldConflictView = {
  changeId: string;
  field: string;
  valuesByActor: Record<string, unknown>;
};

/** Mirrors `resolvableConflictFieldSchema` (src/lib/change-drafts/schemas.ts) -- the only fields
 * realistic for two devices to actually conflict on in practice, and the only ones the resolve
 * API accepts. Any other field is still displayed (never hidden), just without a resolve action. */
const RESOLVABLE_CONFLICT_FIELDS = new Set(["proposedValue", "approvalStatus", "approvedValue", "conflictStatus"]);

type SyncCycleResponse = {
  deviceId: string;
  channels: Array<{
    channelId: string;
    pushed: boolean;
    pushError: string | null;
    peersMerged: string[];
    peersSkipped: Array<{ deviceId: string; reason: string }>;
    newConflicts: FieldConflictView[];
  }>;
  totalNewConflicts: number;
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message ?? `Request to ${url} failed (${res.status})`);
  }
  return data as T;
}

export function DeviceHandoffPanel({ channelId }: { channelId: string | null }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [syncthingRootPath, setSyncthingRootPath] = useState("");
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<FieldConflictView[]>([]);
  const [syncBusy, setSyncBusy] = useState(false);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);
  const [syncPushErrors, setSyncPushErrors] = useState<Array<{ channelId: string; reason: string }>>([]);
  const [syncPeersSkipped, setSyncPeersSkipped] = useState<Array<{ channelId: string; deviceId: string; reason: string }>>([]);
  const [pendingResolution, setPendingResolution] = useState<{
    changeId: string;
    field: string;
    winningActorId: string;
    value: string;
  } | null>(null);
  const [resolveBusy, setResolveBusy] = useState(false);
  // A plain ref, not just the `resolveBusy` state: a rapid double-click can dispatch two click
  // events before React re-renders with the updated `disabled`-driven UI, and both handler
  // invocations would otherwise read `resolveBusy` from the same stale render's closure. A ref
  // mutates synchronously, so the second invocation sees the lock immediately.
  const resolveInFlight = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await fetchJson<StatusResponse>("/api/device-handoff/status");
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load status");
    }
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      const data = await fetchJson<{ syncthingRootPath: string | null }>(
        "/api/device-handoff/bootstrap-config"
      );
      setSyncthingRootPath(data.syncthingRootPath ?? "");
    } catch {
      // non-fatal -- first-run config may not exist yet
    }
  }, []);

  const refreshSnapshots = useCallback(async () => {
    try {
      const data = await fetchJson<{ snapshots: SnapshotSummary[] }>("/api/device-handoff/snapshots");
      setSnapshots(data.snapshots);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to list snapshots");
    }
  }, []);

  const refreshConflicts = useCallback(async () => {
    if (!channelId) {
      setConflicts([]);
      return;
    }
    try {
      const data = await fetchJson<{ conflicts: FieldConflictView[] }>(
        `/api/channels/${channelId}/change-drafts/conflicts`
      );
      setConflicts(data.conflicts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load draft conflicts");
    }
  }, [channelId]);

  useEffect(() => {
    void refreshStatus();
    void refreshConfig();
    void refreshSnapshots();
  }, [refreshStatus, refreshConfig, refreshSnapshots]);

  useEffect(() => {
    void refreshConflicts();
  }, [refreshConflicts]);

  async function handleSyncNow() {
    setSyncBusy(true);
    setError(null);
    try {
      const result = await fetchJson<SyncCycleResponse>("/api/change-drafts/sync", { method: "POST" });
      const channelsPushed = result.channels.filter((c) => c.pushed).length;
      const peersSeen = new Set(result.channels.flatMap((c) => c.peersMerged)).size;
      setLastSyncSummary(
        `Synced ${result.channels.length} channel(s): ${channelsPushed} pushed, merged from ` +
          `${peersSeen} other device(s), ${result.totalNewConflicts} new conflict(s) this cycle.`
      );
      setSyncPushErrors(
        result.channels
          .filter((c) => c.pushError)
          .map((c) => ({ channelId: c.channelId, reason: c.pushError! }))
      );
      setSyncPeersSkipped(
        result.channels.flatMap((c) => c.peersSkipped.map((p) => ({ channelId: c.channelId, ...p })))
      );
      await refreshConflicts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncBusy(false);
    }
  }

  async function handleResolveConflict() {
    if (!pendingResolution || !channelId || resolveInFlight.current) return;
    resolveInFlight.current = true;
    setResolveBusy(true);
    setError(null);
    try {
      await fetchJson(`/api/channels/${channelId}/change-drafts/conflicts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changeId: pendingResolution.changeId,
          field: pendingResolution.field,
          winningActorId: pendingResolution.winningActorId,
        }),
      });
      setPendingResolution(null);
      await refreshConflicts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve conflict");
    } finally {
      resolveInFlight.current = false;
      setResolveBusy(false);
    }
  }

  async function handleSaveConfig() {
    setBusy("config");
    setError(null);
    try {
      await fetchJson("/api/device-handoff/bootstrap-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ syncthingRootPath: syncthingRootPath || null }),
      });
      await refreshSnapshots();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save folder");
    } finally {
      setBusy(null);
    }
  }

  async function handleExport() {
    setBusy("export");
    setError(null);
    setLastResult(null);
    try {
      const result = await fetchJson<{ snapshotId: string; generation: number }>(
        "/api/device-handoff/export",
        { method: "POST" }
      );
      setLastResult(
        `Exported as snapshot ${result.snapshotId} (generation ${result.generation}). ` +
          "This only records that export finished on this device -- it does not confirm any " +
          "other device has stopped."
      );
      await refreshSnapshots();
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleImport(snapshotId: string) {
    setBusy(`import-${snapshotId}`);
    setError(null);
    setLastResult(null);
    try {
      const result = await fetchJson<{ status: string }>("/api/device-handoff/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId }),
      });
      setLastResult(
        result.status === "activated_recovery_mode"
          ? "Imported, but this device now has unresolved YouTube operation state -- restricted " +
              "recovery mode is active. See below."
          : result.status === "duplicate_noop"
            ? "This snapshot is already the current state on this device -- nothing changed."
            : "Imported and activated normally."
      );
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleAcknowledge() {
    setBusy("acknowledge");
    setError(null);
    try {
      await fetchJson("/api/device-handoff/acknowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "Reviewed via dashboard" }),
      });
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record acknowledgement");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {lastResult && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-300">
          {lastResult}
        </div>
      )}

      {status?.recoveryMode && (
        <div className="rounded-lg border border-amber-700 bg-amber-950/40 px-4 py-4 text-sm text-amber-200">
          <p className="mb-2 font-semibold">Restricted recovery mode</p>
          <p className="mb-3">
            This device has {status.unresolved.length} batch execution row(s) with an uncertain
            YouTube write outcome (imported from a snapshot). Every mutating action &mdash; local
            state and YouTube writes alike &mdash; is refused until this is resolved through the
            existing recovery mechanism. Acknowledging below only records that you have reviewed
            this; it never changes any row&rsquo;s status or lifts this restriction by itself.
          </p>
          <ul className="mb-3 list-disc space-y-1 pl-5 font-mono text-xs">
            {status.unresolved.map((row) => (
              <li key={row.ledgerRowId}>
                batch {row.batchId} / video {row.videoId}: {row.status}
              </li>
            ))}
          </ul>
          <button
            onClick={handleAcknowledge}
            disabled={busy === "acknowledge"}
            className="rounded-md border border-amber-600 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
          >
            {busy === "acknowledge" ? "Recording..." : "I've reviewed this (acknowledge only)"}
          </button>
        </div>
      )}

      {status?.lock && (
        <div className="rounded-lg border border-blue-800 bg-blue-950/40 px-4 py-3 text-sm text-blue-200">
          An {status.lock.operationType} operation is currently in progress on this device
          (started {status.lock.acquiredAt}).
        </div>
      )}

      <div>
        <h2 className="mb-2 text-lg font-semibold">Syncthing folder</h2>
        <p className="mb-3 text-sm text-zinc-400">
          The local directory Syncthing shares with the other device. Snapshots are published
          here on export and read from here on import. Leave empty to work local-only (nothing
          leaves this device).
        </p>
        <div className="flex gap-2">
          <input
            value={syncthingRootPath}
            onChange={(e) => setSyncthingRootPath(e.target.value)}
            placeholder="e.g. D:\\Sync\\yt-ops-manager"
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
          />
          <button
            onClick={handleSaveConfig}
            disabled={busy === "config"}
            className="rounded-md border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
          >
            {busy === "config" ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Change drafts sync</h2>
        <p className="mb-3 text-sm text-zinc-400">
          Change Sets and their proposed changes sync continuously in the background between
          devices sharing the folder above (checked automatically every minute while this app is
          open) &mdash; this button just runs one cycle immediately. A conflict below means two
          devices edited the same field while offline; nothing is ever picked automatically &mdash;
          choose which version to keep below when one appears.
        </p>
        <button
          onClick={handleSyncNow}
          disabled={syncBusy}
          className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
        >
          {syncBusy ? "Syncing..." : "Sync now"}
        </button>
        {lastSyncSummary && <p className="mt-3 text-sm text-zinc-400">{lastSyncSummary}</p>}

        {syncPushErrors.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-700 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
            <p className="mb-1 font-semibold">Sync folder unreachable for {syncPushErrors.length} channel(s)</p>
            <ul className="list-disc space-y-1 pl-5 text-xs">
              {syncPushErrors.map((e) => (
                <li key={e.channelId}>
                  {e.channelId}: {e.reason}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-300">
              Nothing local was lost &mdash; this device&rsquo;s changes just weren&rsquo;t published this
              cycle. Check that the Syncthing folder above is actually mounted/reachable.
            </p>
          </div>
        )}

        {syncPeersSkipped.length > 0 && (
          <div className="mt-3 rounded-lg border border-orange-700 bg-orange-950/40 px-4 py-3 text-sm text-orange-200">
            <p className="mb-1 font-semibold">
              {syncPeersSkipped.length} peer device file(s) could not be merged this cycle
            </p>
            <ul className="list-disc space-y-1 pl-5 text-xs">
              {syncPeersSkipped.map((p, i) => (
                <li key={`${p.channelId}.${p.deviceId}.${i}`}>
                  {p.channelId}, device {p.deviceId.slice(0, 8)}: {p.reason}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-orange-300">
              This is not a field-level conflict to choose between &mdash; it means this device
              and that one can&rsquo;t currently combine their history at all (e.g. a corrupted
              file, or a genuinely divergent setup). It will keep being skipped every cycle until
              resolved outside this screen.
            </p>
          </div>
        )}

        {conflicts.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {conflicts.map((conflict) => {
              const resolvable = RESOLVABLE_CONFLICT_FIELDS.has(conflict.field);
              return (
                <li
                  key={`${conflict.changeId}.${conflict.field}`}
                  className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3"
                >
                  <p className="mb-2 text-xs uppercase text-red-300">
                    Conflict &mdash; change {conflict.changeId}, field &ldquo;{conflict.field}&rdquo;
                  </p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {Object.entries(conflict.valuesByActor).map(([actor, value]) => (
                      <div key={actor}>
                        <p className="text-[10px] uppercase text-zinc-600">Version ({actor.slice(0, 8)})</p>
                        <p className="whitespace-pre-wrap text-sm text-zinc-100">{String(value)}</p>
                        {resolvable && (
                          <button
                            onClick={() =>
                              setPendingResolution({
                                changeId: conflict.changeId,
                                field: conflict.field,
                                winningActorId: actor,
                                value: String(value),
                              })
                            }
                            className="mt-1 rounded-md border border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-300 hover:border-zinc-500"
                          >
                            Use this version
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {!resolvable && (
                    <p className="mt-2 text-xs text-zinc-500">
                      This field can&rsquo;t be resolved from this screen yet &mdash; contact support.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          !!channelId && <p className="mt-4 text-sm text-zinc-500">No unresolved conflicts for this channel.</p>
        )}
      </div>

      {pendingResolution && (
        <ConfirmDialog
          title="Resolve conflict?"
          description={`This will overwrite the competing value(s) for "${pendingResolution.field}" with: "${pendingResolution.value}". This cannot be undone once synced to other devices.`}
          confirmLabel={resolveBusy ? "Resolving..." : "Use this version"}
          onCancel={() => setPendingResolution(null)}
          onConfirm={handleResolveConflict}
        />
      )}

      <div>
        <h2 className="mb-2 text-lg font-semibold">Finish work on this device</h2>
        <p className="mb-3 text-sm text-zinc-400">
          Exports a scrubbed snapshot (never includes OAuth tokens or AI connection
          credentials) into the Syncthing folder above. This records that export finished here
          &mdash; it does not and cannot confirm any other device has stopped.
        </p>
        <button
          onClick={handleExport}
          disabled={busy === "export" || status?.recoveryMode || !!status?.lock}
          className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
        >
          {busy === "export" ? "Exporting..." : "Export handoff"}
        </button>
      </div>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Continue work on this device</h2>
        <p className="mb-3 text-sm text-zinc-400">
          Available snapshots in the configured folder. Importing never resumes an
          in-progress/uncertain YouTube write automatically.
        </p>
        {snapshots.length === 0 && (
          <p className="text-sm text-zinc-500">No snapshots found.</p>
        )}
        <ul className="space-y-2">
          {snapshots.map((snap) => (
            <li
              key={snap.snapshotId}
              className="flex items-center justify-between rounded-md border border-zinc-800 px-3 py-2 text-sm"
            >
              <span className="font-mono text-xs text-zinc-400">
                {snap.snapshotId} (device {snap.sourceDeviceId}, gen {snap.generation},{" "}
                {snap.createdAt})
              </span>
              <button
                onClick={() => handleImport(snap.snapshotId)}
                disabled={busy !== null || !!status?.lock}
                className="rounded-md border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
              >
                {busy === `import-${snap.snapshotId}` ? "Importing..." : "Import"}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
