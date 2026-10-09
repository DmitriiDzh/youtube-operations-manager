"use client";

import { errorText, isUiTextKey } from "@/lib/ui-text";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { OperationLockControl } from "@/components/operation-lock-control";
import { DeviceSyncDivergenceCard } from "@/components/device-sync-divergence-card";
import { ConflictCenter, useConflictCenter } from "@/components/conflict-center";
import { useT } from "@/components/ui-text-provider";
import type { Translate, UiTextKey } from "@/lib/ui-text";

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
type SyncFamily = "change_drafts" | "editorial_profile" | "ai_connections" | "media_sessions" | "generation_plans" | "media_settings" | "agent_tokens";

const FAMILY_LABELS: Record<SyncFamily, UiTextKey> = {
  change_drafts: "handoff.family.changeDrafts",
  editorial_profile: "handoff.family.editorialProfiles",
  ai_connections: "handoff.family.aiConnections",
  media_sessions: "handoff.family.mediaSessions",
  generation_plans: "handoff.family.generationPlans",
  media_settings: "handoff.family.mediaSettings",
  agent_tokens: "handoff.family.agentTokens",
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

async function fetchJson<T>(t: Translate, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok && res.status !== 207) {
    throw new Error(errorText(t, data, t("handoff.requestFailed", { url, status: String(res.status) }), { showErrorField: false }));
  }
  return data as T;
}

/** Why a peer's data was skipped: a known reason code in words (its `errors.<code>` text), otherwise the code as sent. */
function peerSkipReason(t: Translate, reason: string): string {
  const key = `errors.${reason}`;
  return isUiTextKey(key) ? t(key) : reason;
}

function formatRelativeTime(t: Translate, iso: string | null): string {
  if (!iso) return t("common.never");
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return t("handoff.justNow");
  if (minutes < 60) return t("handoff.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("handoff.hoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  return t("handoff.daysAgo", { count: days });
}

export function DeviceHandoffPanel({ channelId }: { channelId: string | null }) {
  const t = useT();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const [syncStatuses, setSyncStatuses] = useState<SyncFamilyStatusView[]>([]);
  const [changeDraftConflicts, setChangeDraftConflicts] = useState<UnifiedConflict[]>([]);
  const [editorialProfileConflicts, setEditorialProfileConflicts] = useState<UnifiedConflict[]>([]);
  const [aiConnectionConflicts, setAiConnectionConflicts] = useState<UnifiedConflict[]>([]);

  const [syncBusy, setSyncBusy] = useState(false);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);
  const [syncPushErrors, setSyncPushErrors] = useState<Array<{ family: SyncFamily; channelId: string | null; reason: string }>>([]);
  const [syncPeersSkipped, setSyncPeersSkipped] = useState<PeerSkipped[]>([]);

  const conflictCenter = useConflictCenter(true);
  const [pendingAdoptPeer, setPendingAdoptPeer] = useState<{ family: SyncFamily; channelId: string | null; peerDeviceId: string } | null>(null);
  const [adoptBusy, setAdoptBusy] = useState(false);
  const [lastAdoptResult, setLastAdoptResult] = useState<string | null>(null);
  const adoptInFlight = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await fetchJson<StatusResponse>(t, "/api/device-handoff/status");
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("handoff.error.loadStatus"));
    }
  }, [t]);

  const refreshSnapshots = useCallback(async () => {
    try {
      const data = await fetchJson<{ snapshots: SnapshotSummary[] }>(t, "/api/device-handoff/snapshots");
      setSnapshots(data.snapshots);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("handoff.error.listSnapshots"));
    }
  }, [t]);

  const refreshSyncStatuses = useCallback(async () => {
    try {
      const data = await fetchJson<{ statuses: SyncFamilyStatusView[] }>(t, "/api/change-drafts/sync-status");
      setSyncStatuses(data.statuses);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("handoff.error.loadSyncStatus"));
    }
  }, [t]);

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
            t,
            `/api/channels/${channelId}/change-drafts/conflicts`
          ),
          fetchJson<{ conflicts: Array<{ field: string; valuesByActor: Record<string, unknown> }> }>(
            t,
            `/api/channels/${channelId}/editorial-profile/conflicts`
          ),
        ]);

        setChangeDraftConflicts(
          changeDrafts.conflicts.map((c) => ({
            family: "change_drafts",
            key: `change_drafts.${c.changeId}.${c.field}`,
            subject: t("handoff.subject.change", { id: c.changeId }),
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
            subject: t("handoff.subject.editorialProfile"),
            field: c.field,
            valuesByActor: c.valuesByActor,
            resolvable: true,
          }))
        );
      } catch (err) {
        refreshErrors.push(err instanceof Error ? err.message : t("handoff.error.loadConflicts"));
      }
    }

    try {
      const aiConnections = await fetchJson<{
        conflicts: Array<{ connectionId: string; field: string; valuesByActor: Record<string, unknown> }>;
      }>(t, "/api/ai-connections/conflicts");
      setAiConnectionConflicts(
        aiConnections.conflicts.map((c) => ({
          family: "ai_connections",
          key: `ai_connections.${c.connectionId}.${c.field}`,
          subject: t("handoff.subject.connection", { id: c.connectionId }),
          field: c.field,
          connectionId: c.connectionId,
          valuesByActor: c.valuesByActor,
          resolvable: true,
        }))
      );
    } catch (err) {
      refreshErrors.push(err instanceof Error ? err.message : t("handoff.error.loadAiConflicts"));
    }

    if (refreshErrors.length > 0) setError(refreshErrors.join(" "));
  }, [channelId, t]);

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
      const result = await fetchJson<SyncCycleResponse>(t, "/api/change-drafts/sync", { method: "POST" });
      const { editorialProfile, aiConnections } = result;
      const changeDraftsOk = "channels" in result;
      const channelsPushed = changeDraftsOk ? result.channels.filter((c) => c.pushed).length : 0;
      const peersSeen = changeDraftsOk ? new Set(result.channels.flatMap((c) => c.peersMerged)).size : 0;
      const profilesPushed = "channels" in editorialProfile ? editorialProfile.channels.filter((c) => c.pushed).length : 0;
      const connectionsPushed = "channels" in aiConnections ? aiConnections.channels.some((c) => c.pushed) : false;
      setLastSyncSummary(
        [
          changeDraftsOk
            ? t("handoff.summary.changeDrafts", {
                pushed: channelsPushed,
                total: result.channels.length,
                peers: peersSeen,
                conflicts: result.totalNewConflicts,
              })
            : t("handoff.summary.changeDraftsFailed", { error: result.error }),
          "channels" in editorialProfile
            ? t("handoff.summary.profiles", { pushed: profilesPushed, conflicts: editorialProfile.totalNewConflicts })
            : t("handoff.summary.profilesFailed", { error: editorialProfile.error }),
          "channels" in aiConnections
            ? t(connectionsPushed ? "handoff.summary.connectionsPushed" : "handoff.summary.connectionsNothing", {
                conflicts: aiConnections.totalNewConflicts,
              })
            : t("handoff.summary.connectionsFailed", { error: aiConnections.error }),
        ].join(" ")
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

      // Known, deliberately-accepted limitation (independent review): if both of these fail in
      // the same call, whichever's own internal `setError` runs second silently wins the shared
      // `error` banner -- the same last-writer-wins class `refreshConflicts` itself was just
      // fixed for internally. Not fixed here: doing so properly means changing what
      // `refreshConflicts`/`refreshSyncStatuses` return to every other caller (the mount effect
      // also calls them), a bigger, riskier change than this one call site's benefit justifies.
      // Lower severity than the `refreshConflicts` case: `syncStatuses`' own per-row `lastError`
      // (rendered below) still shows each family's real status either way, so a lost banner
      // message here is not a total loss of signal.
      await Promise.all([refreshConflicts(), refreshSyncStatuses(), conflictCenter.refresh()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("handoff.error.syncFailed"));
    } finally {
      setSyncBusy(false);
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

      const result = await fetchJson<{ backupPath: string | null }>(t, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ peerDeviceId: pendingAdoptPeer.peerDeviceId }),
      });
      setLastAdoptResult(
        result.backupPath
          ? t("handoff.adopted", { device: pendingAdoptPeer.peerDeviceId.slice(0, 8), path: result.backupPath })
          : t("handoff.adoptedNoBackup", { device: pendingAdoptPeer.peerDeviceId.slice(0, 8) })
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
      setError(err instanceof Error ? err.message : t("handoff.error.adoptFailed"));
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
        t,
        "/api/device-handoff/export",
        { method: "POST" }
      );
      setLastResult(t("handoff.exported", { snapshot: result.snapshotId, generation: String(result.generation) }));
      await refreshSnapshots();
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("handoff.error.exportFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function handleImport(snapshotId: string) {
    setBusy(`import-${snapshotId}`);
    setError(null);
    setLastResult(null);
    try {
      const result = await fetchJson<{ status: string }>(t, "/api/device-handoff/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId }),
      });
      setLastResult(
        result.status === "activated_recovery_mode"
          ? t("handoff.imported.recovery")
          : result.status === "duplicate_noop"
            ? t("handoff.imported.duplicate")
            : t("handoff.imported.ok")
      );
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("handoff.error.importFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function handleAcknowledge() {
    setBusy("acknowledge");
    setError(null);
    try {
      await fetchJson(t, "/api/device-handoff/acknowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // ui-text-ignore: an audit note sent to the API, not shown in the interface
        body: JSON.stringify({ note: "Reviewed via dashboard" }),
      });
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("handoff.error.acknowledgeFailed"));
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
          <p className="mb-2 font-semibold">{t("handoff.recovery.title")}</p>
          <p className="mb-3">{t("handoff.recovery.body", { count: status.unresolved.length })}</p>
          <ul className="mb-3 list-disc space-y-1 pl-5 font-mono text-xs">
            {status.unresolved.map((row) => (
              <li key={row.ledgerRowId}>
                {t("handoff.recovery.row", { batch: row.batchId, video: row.videoId, status: row.status })}
              </li>
            ))}
          </ul>
          <button
            onClick={handleAcknowledge}
            disabled={busy === "acknowledge"}
            className="rounded-md border border-amber-600 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
          >
            {busy === "acknowledge" ? t("handoff.recovery.recording") : t("handoff.recovery.acknowledge")}
          </button>
        </div>
      )}

      {status?.lock && <OperationLockControl onChanged={() => void refreshStatus()} />}

      <DeviceSyncDivergenceCard />

      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("handoff.syncStatus.title")}</h2>
          <button
            onClick={handleSyncNow}
            disabled={syncBusy}
            className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
          >
            {syncBusy ? t("common.syncing") : t("common.syncNow")}
          </button>
        </div>
        <p className="mb-3 text-sm text-zinc-400">{t("handoff.syncStatus.intro")}</p>

        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {syncStatuses.map((s) => {
            const familyConflictCount =
              s.family === "change_drafts"
                ? changeDraftConflicts.length
                : s.family === "editorial_profile"
                  ? editorialProfileConflicts.length
                  : s.family === "ai_connections"
                    ? aiConnectionConflicts.length
                    : s.family === "media_settings"
                      ? conflictCenter.settings.length
                      : 0;
            return (
              <li key={s.family} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="font-medium text-zinc-200">{t(FAMILY_LABELS[s.family])}</span>
                <span className="flex items-center gap-3 text-xs">
                  <span
                    className={
                      s.lastSyncOk === false ? "text-red-400" : s.lastSyncOk === null ? "text-zinc-500" : "text-emerald-400"
                    }
                  >
                    {s.lastSyncOk === false
                      ? t("handoff.syncStatus.failed")
                      : s.lastSyncOk === null
                        ? t("handoff.syncStatus.never")
                        : t("handoff.syncStatus.ok")}
                    {s.lastSyncedAt && ` · ${formatRelativeTime(t, s.lastSyncedAt)}`}
                  </span>
                  {familyConflictCount > 0 && (
                    <span className="rounded-full bg-red-900/60 px-2 py-0.5 text-red-200">
                      {t("handoff.syncStatus.conflicts", { count: familyConflictCount })}
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
            <p className="mb-1 font-semibold">{t("handoff.pushErrors.title", { count: syncPushErrors.length })}</p>
            <ul className="list-disc space-y-1 pl-5 text-xs">
              {syncPushErrors.map((e, i) => (
                <li key={`${e.family}.${e.channelId}.${i}`}>
                  {t(FAMILY_LABELS[e.family])}
                  {e.channelId ? ` (${e.channelId})` : ""}: {e.reason}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-300">{t("handoff.pushErrors.hint")}</p>
          </div>
        )}

        {syncPeersSkipped.length > 0 && (
          <div className="mt-3 rounded-lg border border-orange-700 bg-orange-950/40 px-4 py-3 text-sm text-orange-200">
            <p className="mb-1 font-semibold">{t("handoff.peersSkipped.title", { count: syncPeersSkipped.length })}</p>
            <ul className="space-y-2 text-xs">
              {syncPeersSkipped.map((p, i) => (
                <li key={`${p.family}.${p.channelId}.${p.deviceId}.${i}`} className="list-disc pl-5">
                  {t("handoff.peersSkipped.row", {
                    family: t(FAMILY_LABELS[p.family]),
                    channel: p.channelId ? ` (${p.channelId})` : "",
                    device: p.deviceId.slice(0, 8),
                    reason: peerSkipReason(t, p.reason),
                  })}
                  {p.reason === "divergent_document_lineage" &&
                    (p.family === "ai_connections" || p.channelId === channelId ? (
                      <div className="mt-1">
                        <button
                          onClick={() => setPendingAdoptPeer({ family: p.family, channelId: p.channelId, peerDeviceId: p.deviceId })}
                          className="rounded-md border border-orange-600 px-2 py-1 text-xs font-medium text-orange-200 hover:bg-orange-900/40"
                        >
                          {t("handoff.peersSkipped.adopt")}
                        </button>
                      </div>
                    ) : (
                      <p className="mt-1 italic text-orange-300">{t("handoff.peersSkipped.switchChannel")}</p>
                    ))}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-orange-300">{t("handoff.peersSkipped.hint")}</p>
          </div>
        )}
        {lastAdoptResult && <p className="mt-3 text-sm text-zinc-400">{lastAdoptResult}</p>}
        {pendingAdoptPeer && (
          <ConfirmDialog
            title={t("handoff.adoptConfirm.title")}
            description={t("handoff.adoptConfirm.body", {
              family: t(FAMILY_LABELS[pendingAdoptPeer.family]).toLowerCase(),
              device: pendingAdoptPeer.peerDeviceId.slice(0, 8),
            })}
            confirmLabel={adoptBusy ? t("handoff.adoptConfirm.adopting") : t("handoff.adoptConfirm.confirm")}
            confirmVariant="danger"
            onCancel={() => setPendingAdoptPeer(null)}
            onConfirm={handleAdoptPeer}
          />
        )}
      </div>

      {/* Owner, msgs 2011/2013: every difference between the computers on one screen -- the same one the startup window shows
          (blocking there, not here). Every connected channel, not only the active one; the snapshot divergence has its own card above. */}
      <div>
        <ConflictCenter state={conflictCenter} hideDivergence />
      </div>

      {/* Visually separated (owner instruction, 2026-09-23: "отдельная карточка") from the
          continuous background sync above -- this is a fundamentally different mechanism: an
          explicit, occasional, whole-copy ownership handoff for the four write-pipeline tables
          that cannot move to continuous CRDT sync at all (`docs/decisions/
          0009-defer-write-pipeline-sync-gateway-migration.md`), never a background process. */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-1 text-lg font-semibold">{t("handoff.title")}</h2>
        <p className="mb-4 text-sm text-zinc-500">{t("handoff.intro")}</p>

        <div className="mb-6">
          <h3 className="mb-2 text-sm font-semibold text-zinc-200">{t("handoff.export.title")}</h3>
          <p className="mb-3 text-sm text-zinc-400">{t("handoff.export.body")}</p>
          <button
            onClick={handleExport}
            disabled={busy === "export" || status?.recoveryMode || !!status?.lock}
            className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
          >
            {busy === "export" ? t("handoff.export.busy") : t("handoff.export.button")}
          </button>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-zinc-200">{t("handoff.import.title")}</h3>
          <p className="mb-3 text-sm text-zinc-400">{t("handoff.import.body")}</p>
          {snapshots.length === 0 && <p className="text-sm text-zinc-500">{t("handoff.import.none")}</p>}
          <ul className="space-y-2">
            {snapshots.map((snap) => (
              <li
                key={snap.snapshotId}
                className="flex items-center justify-between rounded-md border border-zinc-800 px-3 py-2 text-sm"
              >
                <span className="font-mono text-xs text-zinc-400">
                  {t("handoff.import.snapshot", {
                    snapshot: snap.snapshotId,
                    device: snap.sourceDeviceId,
                    generation: String(snap.generation),
                    time: snap.createdAt,
                  })}
                </span>
                <button
                  onClick={() => handleImport(snap.snapshotId)}
                  disabled={busy !== null || !!status?.lock}
                  className="rounded-md border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
                >
                  {busy === `import-${snap.snapshotId}` ? t("handoff.import.busy") : t("handoff.import.button")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
