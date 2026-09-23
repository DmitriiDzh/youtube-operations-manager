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

/** The three sync-gateway document families (`docs/roadmap/plans/
 * FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4) -- mirrors `src/lib/db.ts`'s own `SyncFamily` type,
 * kept as a local structural type rather than importing a server-only module into a client
 * component. */
type SyncFamily = "change_drafts" | "editorial_profile" | "ai_connections";

const FAMILY_LABELS: Record<SyncFamily, string> = {
  change_drafts: "Change drafts",
  editorial_profile: "Editorial profiles",
  ai_connections: "AI connections",
};

type SyncFamilyStatusView = {
  family: SyncFamily;
  lastSyncedAt: string | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
};

/** A conflict from any of the three families, normalized into one shape for a single unified
 * list. `subject` is the human-readable thing that's conflicted (a change's field, a profile
 * field, or a connection's field) -- each family fills it in differently, but the resolve action
 * always needs the same three things: which family, which record (if any), which field, and
 * which competing value to keep. */
type UnifiedConflict = {
  family: SyncFamily;
  key: string;
  subject: string;
  field: string;
  changeId?: string;
  connectionId?: string;
  valuesByActor: Record<string, unknown>;
  resolvable: boolean;
};

/** Mirrors `resolvableConflictFieldSchema` (`change-drafts/schemas.ts`) -- the only change-drafts
 * fields realistic for two devices to actually conflict on, and the only ones its resolve API
 * accepts. Editorial-profile and ai-connections conflicts are always resolvable: `scanForConflicts`
 * in both of those services only ever reports a conflict for a field their own resolve method
 * already handles (there is no equivalent of change-drafts' larger, partly-immutable field set). */
const RESOLVABLE_CHANGE_DRAFT_FIELDS = new Set(["proposedValue", "approvalStatus", "approvedValue", "conflictStatus"]);

type PeerSkipped = { family: SyncFamily; channelId: string | null; deviceId: string; reason: string };

type OtherFamilyCycle =
  | { channels: Array<{ channelId: string; pushed: boolean; pushError: string | null; peersSkipped: Array<{ deviceId: string; reason: string }> }>; totalNewConflicts: number }
  | { error: string };

/** `POST /api/change-drafts/sync`'s own `runAndRecord` isolates each of the 3 families' cycles
 * independently -- ANY of the three, including `change_drafts` at the top level, can come back
 * as `{error: string}` instead of its normal shape if that family's whole cycle threw (found by
 * independent review: an earlier version of this type only modeled that possibility for
 * `editorialProfile`/`aiConnections`, not for the top-level fields, which let a change-drafts
 * cycle failure crash `handleSyncNow` on `result.channels.filter(...)` instead of being handled
 * the same way the other two families already were). */
type SyncCycleResponse = (
  | {
      deviceId: string;
      channels: Array<{
        channelId: string;
        pushed: boolean;
        pushError: string | null;
        peersMerged: string[];
        peersSkipped: Array<{ deviceId: string; reason: string }>;
        newConflicts: Array<{ changeId: string; field: string; valuesByActor: Record<string, unknown> }>;
      }>;
      totalNewConflicts: number;
    }
  | { error: string }
) & {
  /** Each catalog's own, independent sync cycle (`docs/roadmap/plans/
   * FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4/M3) -- same "Sync now" click, separate cycles. */
  editorialProfile: OtherFamilyCycle;
  aiConnections: OtherFamilyCycle;
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok && res.status !== 207) {
    throw new Error(data?.message ?? `Request to ${url} failed (${res.status})`);
  }
  return data as T;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function DeviceHandoffPanel({ channelId }: { channelId: string | null }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const [syncStatuses, setSyncStatuses] = useState<SyncFamilyStatusView[]>([]);
  const [changeDraftConflicts, setChangeDraftConflicts] = useState<UnifiedConflict[]>([]);
  const [editorialProfileConflicts, setEditorialProfileConflicts] = useState<UnifiedConflict[]>([]);
  const [aiConnectionConflicts, setAiConnectionConflicts] = useState<UnifiedConflict[]>([]);
  const conflicts = [...changeDraftConflicts, ...editorialProfileConflicts, ...aiConnectionConflicts];

  const [syncBusy, setSyncBusy] = useState(false);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);
  const [syncPushErrors, setSyncPushErrors] = useState<Array<{ family: SyncFamily; channelId: string | null; reason: string }>>([]);
  const [syncPeersSkipped, setSyncPeersSkipped] = useState<PeerSkipped[]>([]);

  const [pendingResolution, setPendingResolution] = useState<{
    family: SyncFamily;
    changeId?: string;
    connectionId?: string;
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
  const [pendingAdoptPeer, setPendingAdoptPeer] = useState<{ family: SyncFamily; channelId: string | null; peerDeviceId: string } | null>(null);
  const [adoptBusy, setAdoptBusy] = useState(false);
  const [lastAdoptResult, setLastAdoptResult] = useState<string | null>(null);
  const adoptInFlight = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await fetchJson<StatusResponse>("/api/device-handoff/status");
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load status");
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

  const refreshSyncStatuses = useCallback(async () => {
    try {
      const data = await fetchJson<{ statuses: SyncFamilyStatusView[] }>("/api/change-drafts/sync-status");
      setSyncStatuses(data.statuses);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sync status");
    }
  }, []);

  const refreshConflicts = useCallback(async () => {
    // Only change-drafts/editorial-profile are per-channel -- ai-connections is device-wide
    // (`ai_connections` has no `channel_id` at all, `GET /api/ai-connections/conflicts`'s own
    // doc comment), so it must be fetched regardless of whether a channel is active. Found by
    // independent review: an earlier version of this function gated ALL THREE families behind
    // `!channelId`, which silently hid real, unresolved ai-connections conflicts (and kept
    // re-wiping them via every post-resolve/adopt refresh) whenever channelId was momentarily
    // null -- channel-info still loading, no channel linked yet, or Data API reads disabled.
    // Two independent try/catch blocks below (per-channel families vs. the device-wide
    // ai-connections one) means either can fail without the other -- accumulated into one array
    // and joined, rather than a plain `setError` in each catch, so a failure in one never
    // silently clobbers a more relevant message already set by the other in the same refresh
    // (found by independent review: the naive version let whichever block's catch ran LAST win).
    const refreshErrors: string[] = [];

    if (!channelId) {
      setChangeDraftConflicts([]);
      setEditorialProfileConflicts([]);
    } else {
      try {
        const [changeDrafts, editorialProfile] = await Promise.all([
          fetchJson<{ conflicts: Array<{ changeId: string; field: string; valuesByActor: Record<string, unknown> }> }>(
            `/api/channels/${channelId}/change-drafts/conflicts`
          ),
          fetchJson<{ conflicts: Array<{ field: string; valuesByActor: Record<string, unknown> }> }>(
            `/api/channels/${channelId}/editorial-profile/conflicts`
          ),
        ]);

        setChangeDraftConflicts(
          changeDrafts.conflicts.map((c) => ({
            family: "change_drafts",
            key: `change_drafts.${c.changeId}.${c.field}`,
            subject: `change ${c.changeId}`,
            field: c.field,
            changeId: c.changeId,
            valuesByActor: c.valuesByActor,
            resolvable: RESOLVABLE_CHANGE_DRAFT_FIELDS.has(c.field),
          }))
        );
        setEditorialProfileConflicts(
          editorialProfile.conflicts.map((c) => ({
            family: "editorial_profile",
            key: `editorial_profile.${c.field}`,
            subject: "editorial profile",
            field: c.field,
            valuesByActor: c.valuesByActor,
            resolvable: true,
          }))
        );
      } catch (err) {
        refreshErrors.push(err instanceof Error ? err.message : "Failed to load conflicts");
      }
    }

    try {
      const aiConnections = await fetchJson<{
        conflicts: Array<{ connectionId: string; field: string; valuesByActor: Record<string, unknown> }>;
      }>("/api/ai-connections/conflicts");
      setAiConnectionConflicts(
        aiConnections.conflicts.map((c) => ({
          family: "ai_connections",
          key: `ai_connections.${c.connectionId}.${c.field}`,
          subject: `connection ${c.connectionId}`,
          field: c.field,
          connectionId: c.connectionId,
          valuesByActor: c.valuesByActor,
          resolvable: true,
        }))
      );
    } catch (err) {
      refreshErrors.push(err instanceof Error ? err.message : "Failed to load AI-connection conflicts");
    }

    if (refreshErrors.length > 0) setError(refreshErrors.join(" "));
  }, [channelId]);

  useEffect(() => {
    void refreshStatus();
    void refreshSnapshots();
    void refreshSyncStatuses();
  }, [refreshStatus, refreshSnapshots, refreshSyncStatuses]);

  useEffect(() => {
    void refreshConflicts();
  }, [refreshConflicts]);

  async function handleSyncNow() {
    setSyncBusy(true);
    setError(null);
    try {
      const result = await fetchJson<SyncCycleResponse>("/api/change-drafts/sync", { method: "POST" });
      const { editorialProfile, aiConnections } = result;
      const changeDraftsOk = "channels" in result;
      const channelsPushed = changeDraftsOk ? result.channels.filter((c) => c.pushed).length : 0;
      const peersSeen = changeDraftsOk ? new Set(result.channels.flatMap((c) => c.peersMerged)).size : 0;
      const profilesPushed = "channels" in editorialProfile ? editorialProfile.channels.filter((c) => c.pushed).length : 0;
      const connectionsPushed = "channels" in aiConnections ? aiConnections.channels.some((c) => c.pushed) : false;
      setLastSyncSummary(
        `Change drafts: ${changeDraftsOk ? `${channelsPushed}/${result.channels.length} channel(s) pushed, merged from ${peersSeen} other device(s), ${result.totalNewConflicts} new conflict(s)` : `failed (${result.error})`}. ` +
          `Editorial profiles: ${"channels" in editorialProfile ? `${profilesPushed} pushed, ${editorialProfile.totalNewConflicts} new conflict(s)` : `failed (${editorialProfile.error})`}. ` +
          `AI connections: ${"channels" in aiConnections ? `${connectionsPushed ? "pushed" : "nothing to push"}, ${aiConnections.totalNewConflicts} new conflict(s)` : `failed (${aiConnections.error})`}.`
      );

      const pushErrors: Array<{ family: SyncFamily; channelId: string | null; reason: string }> = [];
      const peersSkipped: PeerSkipped[] = [];
      if (changeDraftsOk) {
        for (const c of result.channels) {
          if (c.pushError) pushErrors.push({ family: "change_drafts", channelId: c.channelId, reason: c.pushError });
          for (const p of c.peersSkipped) peersSkipped.push({ family: "change_drafts", channelId: c.channelId, ...p });
        }
      } else {
        pushErrors.push({ family: "change_drafts", channelId: null, reason: result.error });
      }
      if ("channels" in editorialProfile) {
        for (const c of editorialProfile.channels) {
          if (c.pushError) pushErrors.push({ family: "editorial_profile", channelId: c.channelId, reason: c.pushError });
          for (const p of c.peersSkipped) peersSkipped.push({ family: "editorial_profile", channelId: c.channelId, ...p });
        }
      } else {
        pushErrors.push({ family: "editorial_profile", channelId: null, reason: editorialProfile.error });
      }
      if ("channels" in aiConnections) {
        for (const c of aiConnections.channels) {
          if (c.pushError) pushErrors.push({ family: "ai_connections", channelId: null, reason: c.pushError });
          for (const p of c.peersSkipped) peersSkipped.push({ family: "ai_connections", channelId: null, ...p });
        }
      } else {
        pushErrors.push({ family: "ai_connections", channelId: null, reason: aiConnections.error });
      }
      setSyncPushErrors(pushErrors);
      setSyncPeersSkipped(peersSkipped);

      await Promise.all([refreshConflicts(), refreshSyncStatuses()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncBusy(false);
    }
  }

  async function handleResolveConflict() {
    if (!pendingResolution || resolveInFlight.current) return;
    resolveInFlight.current = true;
    setResolveBusy(true);
    setError(null);
    try {
      if (pendingResolution.family === "change_drafts") {
        if (!channelId) return;
        await fetchJson(`/api/channels/${channelId}/change-drafts/conflicts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            changeId: pendingResolution.changeId,
            field: pendingResolution.field,
            winningActorId: pendingResolution.winningActorId,
          }),
        });
      } else if (pendingResolution.family === "editorial_profile") {
        if (!channelId) return;
        await fetchJson(`/api/channels/${channelId}/editorial-profile/conflicts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ field: pendingResolution.field, winningActorId: pendingResolution.winningActorId }),
        });
      } else {
        await fetchJson("/api/ai-connections/conflicts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connectionId: pendingResolution.connectionId,
            field: pendingResolution.field,
            winningActorId: pendingResolution.winningActorId,
          }),
        });
      }
      setPendingResolution(null);
      await refreshConflicts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve conflict");
    } finally {
      resolveInFlight.current = false;
      setResolveBusy(false);
    }
  }

  async function handleAdoptPeer() {
    if (!pendingAdoptPeer || adoptInFlight.current) return;
    adoptInFlight.current = true;
    setAdoptBusy(true);
    setError(null);
    try {
      const url =
        pendingAdoptPeer.family === "change_drafts"
          ? `/api/channels/${pendingAdoptPeer.channelId}/change-drafts/adopt-peer`
          : pendingAdoptPeer.family === "editorial_profile"
            ? `/api/channels/${pendingAdoptPeer.channelId}/editorial-profile/adopt-peer`
            : "/api/ai-connections/adopt-peer";

      const result = await fetchJson<{ backupPath: string | null }>(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ peerDeviceId: pendingAdoptPeer.peerDeviceId }),
      });
      setLastAdoptResult(
        result.backupPath
          ? `Adopted device ${pendingAdoptPeer.peerDeviceId.slice(0, 8)}'s version. Your previous local copy was backed up to ${result.backupPath}.`
          : `Adopted device ${pendingAdoptPeer.peerDeviceId.slice(0, 8)}'s version (there was no local copy to back up).`
      );
      // The just-resolved entry is now stale -- remove it immediately rather than leaving a
      // misleading "could not be merged" warning on screen until the next sync cycle re-runs
      // (found during live verification: the warning box otherwise persisted right after a
      // successful, real adopt).
      setSyncPeersSkipped((prev) =>
        prev.filter(
          (p) =>
            !(
              p.family === pendingAdoptPeer.family &&
              p.channelId === pendingAdoptPeer.channelId &&
              p.deviceId === pendingAdoptPeer.peerDeviceId
            )
        )
      );
      setPendingAdoptPeer(null);
      await refreshConflicts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to adopt peer's version");
    } finally {
      adoptInFlight.current = false;
      setAdoptBusy(false);
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

      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Sync status</h2>
          <button
            onClick={handleSyncNow}
            disabled={syncBusy}
            className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
          >
            {syncBusy ? "Syncing..." : "Sync now"}
          </button>
        </div>
        <p className="mb-3 text-sm text-zinc-400">
          Change Sets, editorial profiles, and AI connections each sync continuously in the
          background between devices sharing the configured Syncthing folder (Settings &rarr;
          Sync; checked automatically every minute while this app is open) &mdash; the button
          above just runs all three cycles immediately. A conflict below means two devices edited
          the same field while offline; nothing is ever picked automatically &mdash; choose which
          version to keep when one appears.
        </p>

        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {syncStatuses.map((s) => {
            const familyConflictCount =
              s.family === "change_drafts"
                ? changeDraftConflicts.length
                : s.family === "editorial_profile"
                  ? editorialProfileConflicts.length
                  : aiConnectionConflicts.length;
            return (
              <li key={s.family} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="font-medium text-zinc-200">{FAMILY_LABELS[s.family]}</span>
                <span className="flex items-center gap-3 text-xs">
                  <span
                    className={
                      s.lastSyncOk === false ? "text-red-400" : s.lastSyncOk === null ? "text-zinc-500" : "text-emerald-400"
                    }
                  >
                    {s.lastSyncOk === false ? "Failed" : s.lastSyncOk === null ? "Never synced" : "Ok"}
                    {s.lastSyncedAt && ` · ${formatRelativeTime(s.lastSyncedAt)}`}
                  </span>
                  {familyConflictCount > 0 && (
                    <span className="rounded-full bg-red-900/60 px-2 py-0.5 text-red-200">
                      {familyConflictCount} conflict{familyConflictCount === 1 ? "" : "s"}
                    </span>
                  )}
                </span>
                {s.lastError && <p className="w-full text-xs text-red-400">{s.lastError}</p>}
              </li>
            );
          })}
        </ul>

        {lastSyncSummary && <p className="mt-3 text-sm text-zinc-400">{lastSyncSummary}</p>}

        {syncPushErrors.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-700 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
            <p className="mb-1 font-semibold">Sync folder unreachable for {syncPushErrors.length} item(s)</p>
            <ul className="list-disc space-y-1 pl-5 text-xs">
              {syncPushErrors.map((e, i) => (
                <li key={`${e.family}.${e.channelId}.${i}`}>
                  {FAMILY_LABELS[e.family]}
                  {e.channelId ? ` (${e.channelId})` : ""}: {e.reason}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-300">
              Nothing local was lost &mdash; this device&rsquo;s changes just weren&rsquo;t published this
              cycle. Check that the Syncthing folder (Settings &rarr; Sync) is actually mounted/reachable.
            </p>
          </div>
        )}

        {syncPeersSkipped.length > 0 && (
          <div className="mt-3 rounded-lg border border-orange-700 bg-orange-950/40 px-4 py-3 text-sm text-orange-200">
            <p className="mb-1 font-semibold">
              {syncPeersSkipped.length} peer device file(s) could not be merged this cycle
            </p>
            <ul className="space-y-2 text-xs">
              {syncPeersSkipped.map((p, i) => (
                <li key={`${p.family}.${p.channelId}.${p.deviceId}.${i}`} className="list-disc pl-5">
                  {FAMILY_LABELS[p.family]}
                  {p.channelId ? ` (${p.channelId})` : ""}, device {p.deviceId.slice(0, 8)}: {p.reason}
                  {p.reason === "divergent_document_lineage" &&
                    (p.family === "ai_connections" || p.channelId === channelId ? (
                      <div className="mt-1">
                        <button
                          onClick={() => setPendingAdoptPeer({ family: p.family, channelId: p.channelId, peerDeviceId: p.deviceId })}
                          className="rounded-md border border-orange-600 px-2 py-1 text-xs font-medium text-orange-200 hover:bg-orange-900/40"
                        >
                          Discard my local copy, adopt this device&rsquo;s version
                        </button>
                      </div>
                    ) : (
                      <p className="mt-1 italic text-orange-300">Switch to this channel to resolve it here.</p>
                    ))}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-orange-300">
              A field-level conflict (below) is not the same as this &mdash; this means this
              device and that one share no common history at all and can never be automatically
              combined (e.g. a corrupted file, or two devices that started this data
              independently). Only &ldquo;divergent history&rdquo; entries can be resolved here, by
              explicitly discarding one side; any other reason (e.g. a corrupted file) will keep
              being retried automatically on its own.
            </p>
          </div>
        )}
        {lastAdoptResult && <p className="mt-3 text-sm text-zinc-400">{lastAdoptResult}</p>}
        {pendingAdoptPeer && (
          <ConfirmDialog
            title="Discard local copy and adopt peer's version?"
            description={`This permanently replaces this device's local ${FAMILY_LABELS[pendingAdoptPeer.family].toLowerCase()} with device ${pendingAdoptPeer.peerDeviceId.slice(0, 8)}'s version. Your current local copy is backed up to a file first (never deleted outright), but this action itself cannot be undone through this screen.`}
            confirmLabel={adoptBusy ? "Adopting..." : "Discard and adopt"}
            confirmVariant="danger"
            onCancel={() => setPendingAdoptPeer(null)}
            onConfirm={handleAdoptPeer}
          />
        )}
      </div>

      <div>
        <h2 className="mb-2 text-lg font-semibold">Conflicts</h2>
        {conflicts.length > 0 ? (
          <ul className="space-y-3">
            {conflicts.map((conflict) => (
              <li key={conflict.key} className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3">
                <p className="mb-2 text-xs uppercase text-red-300">
                  {FAMILY_LABELS[conflict.family]} &mdash; {conflict.subject}, field &ldquo;{conflict.field}&rdquo;
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {Object.entries(conflict.valuesByActor).map(([actor, value]) => (
                    <div key={actor}>
                      <p className="text-[10px] uppercase text-zinc-600">Version ({actor.slice(0, 8)})</p>
                      <p className="whitespace-pre-wrap text-sm text-zinc-100">{String(value)}</p>
                      {conflict.resolvable && (
                        <button
                          onClick={() =>
                            setPendingResolution({
                              family: conflict.family,
                              changeId: conflict.changeId,
                              connectionId: conflict.connectionId,
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
                {!conflict.resolvable && (
                  <p className="mt-2 text-xs text-zinc-500">
                    This field can&rsquo;t be resolved from this screen yet &mdash; contact support.
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">
            {channelId ? "No unresolved conflicts for this channel or your AI connections." : "No unresolved AI-connection conflicts."}
          </p>
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

      {/* Visually separated (owner instruction, 2026-09-23: "отдельная карточка") from the
          continuous background sync above -- this is a fundamentally different mechanism: an
          explicit, occasional, whole-copy ownership handoff for the four write-pipeline tables
          that cannot move to continuous CRDT sync at all (`docs/decisions/
          0009-defer-write-pipeline-sync-gateway-migration.md`), never a background process. */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-1 text-lg font-semibold">Device handoff</h2>
        <p className="mb-4 text-sm text-zinc-500">
          A separate mechanism from the continuous sync above -- an explicit, one-at-a-time
          transfer of ownership for the YouTube write pipeline (batches, their execution ledger,
          and the audit trail), which cannot sync continuously in the background.
        </p>

        <div className="mb-6">
          <h3 className="mb-2 text-sm font-semibold text-zinc-200">Finish work on this device</h3>
          <p className="mb-3 text-sm text-zinc-400">
            Exports a scrubbed snapshot (never includes OAuth tokens or AI connection
            credentials) into the configured Syncthing folder (Settings &rarr; Sync). This
            records that export finished here &mdash; it does not and cannot confirm any other
            device has stopped.
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
          <h3 className="mb-2 text-sm font-semibold text-zinc-200">Continue work on this device</h3>
          <p className="mb-3 text-sm text-zinc-400">
            Available snapshots in the configured folder. Importing never resumes an
            in-progress/uncertain YouTube write automatically.
          </p>
          {snapshots.length === 0 && <p className="text-sm text-zinc-500">No snapshots found.</p>}
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
    </div>
  );
}
