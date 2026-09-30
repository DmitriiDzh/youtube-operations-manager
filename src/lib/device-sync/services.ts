import path from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { exportHandoff, importHandoff, isDeviceInRecoveryMode, RecoveryModeError } from "@/lib/device-handoff";
import { getOperationLock, OperationLockError } from "@/lib/operation-lock";
import {
  hasUnpublishedLocalChanges,
  isFastForwardOf,
  listSnapshotIdsStrict,
  readLineageFile,
  readLineageState,
  readManifestFromDir,
  SnapshotError,
  type SqlExecutor,
} from "@/lib/snapshot";
import { SchemaVersionError } from "@/lib/schema-versioning";
import {
  AUTO_IMPORT_BACKUP_PREFIX,
  DEVICE_SYNC_KEEP_AUTO_IMPORT_BACKUPS,
  DEVICE_SYNC_KEEP_OWN_SNAPSHOTS,
  DEVICE_SYNC_MIN_EXPORT_INTERVAL_MS,
  DEVICE_SYNC_TRANSFER_GRACE_MS,
  DeviceSyncError,
  EMPTY_DEVICE_SYNC_STATUS,
  TAKE_THEIRS_BACKUP_PREFIX,
  type DecisionInput,
  type DeviceSyncNotice,
  type DeviceSyncStatus,
  type SnapshotEntry,
  type SyncDecision,
} from "./contracts";

// ---------------------------------------------------------------------------------------------
// Pure decision (DEVICE_AUTO_SYNC_PLAN.md §3.2)
// ---------------------------------------------------------------------------------------------

/**
 * Every snapshot id `startId` descends from, as far as the folder and recorded ancestry can tell:
 * recorded `lineage.json` ancestors plus the parent chain through every manifest present.
 */
export function ancestryOf(startId: string | null, snapshots: SnapshotEntry[], recorded: string[] = []): Set<string> {
  const byId = new Map(snapshots.map((s) => [s.snapshotId, s]));
  const result = new Set<string>();
  const queue: string[] = [...recorded];
  const start = startId ? byId.get(startId) : undefined;
  if (start) {
    if (start.parentSnapshotId) queue.push(start.parentSnapshotId);
    queue.push(...(start.ancestors ?? []));
  }
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (result.has(id)) continue;
    result.add(id);
    const entry = byId.get(id);
    if (entry) {
      if (entry.parentSnapshotId) queue.push(entry.parentSnapshotId);
      queue.push(...(entry.ancestors ?? []));
    }
  }
  return result;
}

/**
 * The decision table. "Newer" = another device's snapshot that is neither the local head nor one
 * of its ancestors; of those, only tips (not an ancestor of another newer one) matter.
 */
export function decideSyncAction(input: DecisionInput): SyncDecision {
  const head = input.local.lastSnapshotId;
  const known = ancestryOf(head, input.snapshots, input.local.ancestors);
  if (head) known.add(head);

  const newer = input.snapshots.filter((s) => s.sourceDeviceId !== input.deviceId && !known.has(s.snapshotId));
  const covered = new Set<string>();
  for (const s of newer) for (const id of ancestryOf(s.snapshotId, input.snapshots)) covered.add(id);
  const tips = newer.filter((s) => !covered.has(s.snapshotId)).sort((a, b) => b.generation - a.generation);

  if (tips.length === 0) return input.localDirty ? { kind: "export" } : { kind: "idle" };

  const tip = tips[0];
  if (tips.length > 1) return { kind: "divergence", snapshot: tip, localDirty: input.localDirty, multipleTips: true };
  // A newer schema can't be read by this build at all, whatever the lineage says.
  if (tip.schemaVersion > input.currentSchemaVersion) return { kind: "update_app", snapshot: tip };

  const fastForward =
    isFastForwardOf(tip, tip.ancestors, { lastSnapshotId: head }) ||
    (head !== null && ancestryOf(tip.snapshotId, input.snapshots).has(head));
  if (fastForward && !input.localDirty) return { kind: "import", snapshot: tip };
  return { kind: "divergence", snapshot: tip, localDirty: input.localDirty, multipleTips: false };
}

// ---------------------------------------------------------------------------------------------
// Folder scan, retention
// ---------------------------------------------------------------------------------------------

/** Readable, complete snapshots, and the ids of those not (yet) readable -- usually a Syncthing
 * transfer still in progress (§3.4). */
export async function scanSnapshotFolder(folder: string): Promise<{ snapshots: SnapshotEntry[]; unreadable: string[] }> {
  const snapshots: SnapshotEntry[] = [];
  const unreadable: string[] = [];
  for (const id of await listSnapshotIdsStrict(folder)) {
    const dir = path.join(folder, id);
    try {
      const manifest = await readManifestFromDir(dir);
      if (!manifest.complete || manifest.snapshotId !== id) {
        unreadable.push(id);
        continue;
      }
      snapshots.push({
        snapshotId: manifest.snapshotId,
        parentSnapshotId: manifest.parentSnapshotId,
        sourceDeviceId: manifest.sourceDeviceId,
        generation: manifest.generation,
        schemaVersion: manifest.schemaVersion,
        createdAt: manifest.createdAt,
        ancestors: await readLineageFile(dir, manifest),
      });
    } catch {
      unreadable.push(id);
    }
  }
  return { snapshots, unreadable };
}

/** §3.8: keeps this device's newest `keep` snapshots and always its lineage head; never touches
 * another device's snapshots (Syncthing would propagate the deletion to it). */
export async function pruneOwnSnapshots(params: {
  folder: string;
  deviceId: string;
  headSnapshotId: string | null;
  snapshots: SnapshotEntry[];
  keep?: number;
}): Promise<string[]> {
  const keep = params.keep ?? DEVICE_SYNC_KEEP_OWN_SNAPSHOTS;
  const own = params.snapshots
    .filter((s) => s.sourceDeviceId === params.deviceId)
    .sort((a, b) => b.generation - a.generation || b.createdAt.localeCompare(a.createdAt));
  const removed: string[] = [];
  for (const s of own.slice(keep)) {
    if (s.snapshotId === params.headSnapshotId) continue;
    await rm(path.join(params.folder, s.snapshotId), { recursive: true, force: true });
    removed.push(s.snapshotId);
  }
  return removed;
}

/** Prunes only this feature's own automatic-import backups (never a manual or "take theirs" one). */
export async function pruneAutoImportBackups(dir: string, keep = DEVICE_SYNC_KEEP_AUTO_IMPORT_BACKUPS): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const re = new RegExp(`^${AUTO_IMPORT_BACKUP_PREFIX}-(\\d+)-[0-9a-f]{8}\\.db$`);
  const ours = names
    .map((name) => ({ name, at: Number(re.exec(name)?.[1] ?? NaN) }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => b.at - a.at);
  const removed: string[] = [];
  for (const entry of ours.slice(keep)) {
    await rm(path.join(dir, entry.name), { force: true });
    removed.push(entry.name);
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

export type DeviceSyncDeps = {
  client: SqlExecutor;
  currentSchemaVersion: number;
  /** This device's id and the configured Syncthing folder (`null` = none configured). */
  resolveConfig: () => Promise<{ deviceId: string; folder: string | null }>;
  migrationBackupsDir: string;
  workingDir: string;
  isEnabled: () => Promise<boolean>;
  loadStatus: () => Promise<DeviceSyncStatus>;
  saveStatus: (status: DeviceSyncStatus) => Promise<void>;
  now?: () => number;
};

class SyncAbort extends Error {}

async function hasActiveExecution(client: SqlExecutor): Promise<string | null> {
  const running = (await client.execute("SELECT 1 FROM batches WHERE status = 'RUNNING' LIMIT 1")) as {
    rows: unknown[];
  };
  if (running.rows.length > 0) return "a batch is running";
  const locks = (await client.execute("SELECT 1 FROM video_execution_locks LIMIT 1")) as { rows: unknown[] };
  if (locks.rows.length > 0) return "a video write is in progress";
  return null;
}

function transientSnapshotError(error: unknown): boolean {
  return (
    error instanceof SnapshotError &&
    ["snapshot_file_missing", "snapshot_checksum_mismatch", "snapshot_incomplete", "snapshot_manifest_invalid"].includes(
      error.code
    )
  );
}

function divergenceNotice(snapshot: SnapshotEntry, localDirty: boolean, multipleTips: boolean): DeviceSyncNotice {
  return {
    kind: "divergence",
    message: multipleTips
      ? "Several other computers published data that conflicts. Choose which data to keep."
      : localDirty
        ? "Both computers changed data since they last synced. Choose which computer's data to keep."
        : "The other computer published data that does not continue this computer's history. Choose which data to keep.",
    snapshotId: snapshot.snapshotId,
    sourceDeviceId: snapshot.sourceDeviceId,
    createdAt: snapshot.createdAt,
    localDirty,
  };
}

export function createDeviceSyncRunner(deps: DeviceSyncDeps) {
  const now = deps.now ?? (() => Date.now());

  async function loadStatusSafe(): Promise<DeviceSyncStatus> {
    try {
      return { ...EMPTY_DEVICE_SYNC_STATUS, ...(await deps.loadStatus()) };
    } catch {
      return { ...EMPTY_DEVICE_SYNC_STATUS };
    }
  }

  /** Reasons an automatic action must not run right now (§3.3), outside the lock. */
  async function busyReason(): Promise<{ reason: string; recovery: boolean } | null> {
    if (await getOperationLock(deps.client)) return { reason: "an export/import/migration is in progress", recovery: false };
    if (await isDeviceInRecoveryMode(deps.client)) return { reason: "this computer is in recovery mode", recovery: true };
    const active = await hasActiveExecution(deps.client);
    return active ? { reason: active, recovery: false } : null;
  }

  /** `previous` is the map as loaded at the start of the tick, so a snapshot's first-seen time
   * survives from tick to tick while it stays pending. */
  function withPending(
    status: DeviceSyncStatus,
    previous: Record<string, number>,
    unreadable: string[],
    extra: string[] = []
  ): DeviceSyncStatus {
    const pendingSince: Record<string, number> = {};
    for (const id of [...unreadable, ...extra]) pendingSince[id] = previous[id] ?? now();
    return { ...status, pendingSince };
  }

  function stuckNotice(status: DeviceSyncStatus): DeviceSyncNotice[] {
    const stuck = Object.entries(status.pendingSince).filter(([, since]) => now() - since >= DEVICE_SYNC_TRANSFER_GRACE_MS);
    if (stuck.length === 0) return [];
    return [
      {
        kind: "transfer_stuck",
        message: `${stuck.length} snapshot(s) in the sync folder have been incomplete or unreadable for over 10 minutes. Check that Syncthing is running on both computers.`,
        snapshotId: stuck[0][0],
      },
    ];
  }

  async function exportNow(
    config: { deviceId: string; folder: string },
    supersede?: { snapshotId: string; generation: number; ancestors: string[] },
    requireDirty = true
  ) {
    const result = await exportHandoff({
      client: deps.client,
      snapshotsDir: config.folder,
      deviceId: config.deviceId,
      schemaVersion: deps.currentSchemaVersion,
      supersede,
      assertStillSafe: async () => {
        const active = await hasActiveExecution(deps.client);
        if (active) throw new SyncAbort(active);
        if (requireDirty && !(await hasUnpublishedLocalChanges(deps.client))) throw new SyncAbort("nothing to export");
      },
    });
    try {
      const { snapshots } = await scanSnapshotFolder(config.folder);
      await pruneOwnSnapshots({
        folder: config.folder,
        deviceId: config.deviceId,
        headSnapshotId: result.manifest.snapshotId,
        snapshots,
      });
    } catch {
      // Retention is housekeeping; a failure never fails the export.
    }
    return result.manifest;
  }

  async function importNow(
    folder: string,
    snapshotId: string,
    mode: { acceptDivergentLineage: boolean; requireClean: boolean }
  ) {
    await mkdir(deps.workingDir, { recursive: true });
    await mkdir(deps.migrationBackupsDir, { recursive: true });
    const result = await importHandoff({
      liveClient: deps.client,
      snapshotDir: path.join(folder, snapshotId),
      migrationBackupsDir: deps.migrationBackupsDir,
      workingDir: deps.workingDir,
      acceptDivergentLineage: mode.acceptDivergentLineage,
      backupPrefix: mode.acceptDivergentLineage ? TAKE_THEIRS_BACKUP_PREFIX : AUTO_IMPORT_BACKUP_PREFIX,
      assertStillSafe: async () => {
        const active = await hasActiveExecution(deps.client);
        if (active) throw new SyncAbort(active);
        // AC-AS-07: a local change that landed after the decision aborts the automatic import.
        if (mode.requireClean && (await hasUnpublishedLocalChanges(deps.client))) {
          throw new SyncAbort("local data changed");
        }
      },
    });
    if (!mode.acceptDivergentLineage) {
      await pruneAutoImportBackups(deps.migrationBackupsDir).catch(() => []);
    }
    return result;
  }

  /**
   * One scheduler tick (§3.2-§3.4). Never throws: every outcome is recorded in the status.
   * `force` skips only the minimum export interval ("Sync now"); `exportOnly` (the flush before an
   * idle shutdown) acts only if the decision is an export.
   */
  async function tick(options: { force?: boolean; exportOnly?: boolean } = {}): Promise<DeviceSyncStatus> {
    let status = await loadStatusSafe();
    const previousPending = status.pendingSince ?? {};
    status = { ...status, lastTickAt: new Date(now()).toISOString(), busyReason: null };

    const finish = async (next: DeviceSyncStatus) => {
      try {
        await deps.saveStatus(next);
      } catch {
        // Status is informational; the next tick rewrites it.
      }
      return next;
    };

    try {
      if (!(await deps.isEnabled())) return finish({ ...status, state: "disabled", notices: [] });
      const config = await deps.resolveConfig();
      if (!config.folder) return finish({ ...status, state: "not_configured", notices: [] });
      const folder = config.folder;

      const busy = await busyReason();
      if (busy) {
        const notices: DeviceSyncNotice[] = busy.recovery
          ? [
              {
                kind: "recovery_mode",
                message:
                  "This computer is in recovery mode (a YouTube write's outcome is unknown). Automatic sync is paused until it is resolved.",
              },
            ]
          : status.notices;
        return finish({ ...status, state: "busy", busyReason: busy.reason, notices });
      }

      const { snapshots, unreadable } = await scanSnapshotFolder(folder);
      status = withPending(status, previousPending, unreadable);
      const lineage = await readLineageState(deps.client);
      const localDirty = await hasUnpublishedLocalChanges(deps.client);
      const decision = decideSyncAction({
        deviceId: config.deviceId,
        currentSchemaVersion: deps.currentSchemaVersion,
        local: { lastSnapshotId: lineage.lastSnapshotId, ancestors: lineage.ancestors ?? [] },
        localDirty,
        snapshots,
      });

      if (options.exportOnly && decision.kind !== "export") {
        return finish({ ...status, notices: status.notices });
      }

      switch (decision.kind) {
        case "idle":
          return finish({ ...status, state: Object.keys(status.pendingSince).length ? "waiting" : "synced", notices: stuckNotice(status) });

        case "update_app":
          return finish({
            ...status,
            state: "attention",
            notices: [
              {
                kind: "update_app",
                message: `The other computer uses a newer app version (schema ${decision.snapshot.schemaVersion}). Update the app on this computer to receive its data.`,
                snapshotId: decision.snapshot.snapshotId,
                sourceDeviceId: decision.snapshot.sourceDeviceId,
                createdAt: decision.snapshot.createdAt,
              },
            ],
          });

        case "divergence":
          return finish({
            ...status,
            state: "attention",
            notices: [divergenceNotice(decision.snapshot, decision.localDirty, decision.multipleTips), ...stuckNotice(status)],
          });

        case "export": {
          const lastExportMs = status.lastExportAt ? Date.parse(status.lastExportAt) : 0;
          if (!options.force && now() - lastExportMs < DEVICE_SYNC_MIN_EXPORT_INTERVAL_MS) {
            return finish({ ...status, state: "waiting", notices: stuckNotice(status) });
          }
          const manifest = await exportNow({ deviceId: config.deviceId, folder });
          return finish({
            ...status,
            state: "exported",
            lastExportAt: new Date(now()).toISOString(),
            lastExportSnapshotId: manifest.snapshotId,
            notices: stuckNotice(status),
          });
        }

        case "import": {
          try {
            const result = await importNow(folder, decision.snapshot.snapshotId, {
              acceptDivergentLineage: false,
              requireClean: true,
            });
            const { [decision.snapshot.snapshotId]: _done, ...pendingSince } = status.pendingSince;
            void _done;
            const next: DeviceSyncStatus = {
              ...status,
              pendingSince,
              state: "imported",
              lastImportAt: new Date(now()).toISOString(),
              lastImportSnapshotId: decision.snapshot.snapshotId,
              notices: [],
            };
            if (result.status === "activated_recovery_mode") {
              next.state = "attention";
              next.notices = [
                {
                  kind: "recovery_mode",
                  message:
                    "The imported data contains a YouTube write whose outcome is unknown. This computer is now in recovery mode until it is resolved.",
                },
              ];
            }
            return finish(next);
          } catch (error) {
            if (transientSnapshotError(error)) {
              const next = withPending(status, previousPending, unreadable, [decision.snapshot.snapshotId]);
              return finish({ ...next, state: "waiting", notices: stuckNotice(next) });
            }
            throw error;
          }
        }
      }
    } catch (error) {
      if (error instanceof SyncAbort || error instanceof OperationLockError) {
        return finish({ ...status, state: "busy", busyReason: error.message });
      }
      if (error instanceof SnapshotError && error.code === "snapshot_divergent_lineage") {
        return finish({ ...status, state: "attention" });
      }
      if (error instanceof SchemaVersionError) {
        return finish({
          ...status,
          state: "attention",
          notices: [{ kind: "update_app", message: "The other computer's data needs a newer app version. Update the app on this computer." }],
        });
      }
      if (error instanceof RecoveryModeError) {
        return finish({
          ...status,
          state: "attention",
          notices: [{ kind: "recovery_mode", message: "This computer is in recovery mode. Automatic sync is paused until it is resolved." }],
        });
      }
      return finish({
        ...status,
        state: "attention",
        notices: [{ kind: "error", message: `Automatic sync failed: ${error instanceof Error ? error.message : String(error)}` }],
      });
    }
  }

  /** The other device's snapshot a divergence is about, re-read from the folder -- never trusted
   * from the request beyond its id. */
  async function requirePeerSnapshot(snapshotId: string) {
    const config = await deps.resolveConfig();
    if (!config.folder) throw new DeviceSyncError("device_sync_not_configured", "No sync folder is configured.");
    const { snapshots } = await scanSnapshotFolder(config.folder);
    const snapshot = snapshots.find((s) => s.snapshotId === snapshotId && s.sourceDeviceId !== config.deviceId);
    if (!snapshot) {
      throw new DeviceSyncError("device_sync_snapshot_not_found", "That snapshot from another computer is not in the sync folder.");
    }
    return { config: { deviceId: config.deviceId, folder: config.folder }, snapshot, snapshots };
  }

  /**
   * §3.6 "Keep this computer's data": publish the local state as a child of the other device's
   * snapshot, so that device fast-forwards to it. Explicit human action only.
   */
  async function keepMine(snapshotId: string): Promise<DeviceSyncStatus> {
    const { config, snapshot, snapshots } = await requirePeerSnapshot(snapshotId);
    const busy = await busyReason();
    if (busy) throw new DeviceSyncError("device_sync_busy", `Cannot sync now: ${busy.reason}.`);
    const manifest = await exportNow(
      config,
      { snapshotId: snapshot.snapshotId, generation: snapshot.generation, ancestors: [...ancestryOf(snapshot.snapshotId, snapshots)] },
      false
    );
    const status = await loadStatusSafe();
    const next: DeviceSyncStatus = {
      ...status,
      state: "exported",
      lastExportAt: new Date(now()).toISOString(),
      lastExportSnapshotId: manifest.snapshotId,
      notices: [],
    };
    await deps.saveStatus(next).catch(() => {});
    return next;
  }

  /**
   * §3.6 "Take the other computer's data": import it past the divergence refusal. Every other
   * import check stays (checksums, recovery-mode refusal, backup first). Explicit human action only.
   */
  async function takeTheirs(snapshotId: string): Promise<DeviceSyncStatus> {
    const { config } = await requirePeerSnapshot(snapshotId);
    const busy = await busyReason();
    if (busy && !busy.recovery) throw new DeviceSyncError("device_sync_busy", `Cannot sync now: ${busy.reason}.`);
    const result = await importNow(config.folder, snapshotId, { acceptDivergentLineage: true, requireClean: false });
    const status = await loadStatusSafe();
    const next: DeviceSyncStatus = {
      ...status,
      state: result.status === "activated_recovery_mode" ? "attention" : "imported",
      lastImportAt: new Date(now()).toISOString(),
      lastImportSnapshotId: snapshotId,
      notices:
        result.status === "activated_recovery_mode"
          ? [{ kind: "recovery_mode", message: "The imported data contains a YouTube write whose outcome is unknown. This computer is now in recovery mode." }]
          : [],
    };
    await deps.saveStatus(next).catch(() => {});
    return next;
  }

  return { tick, keepMine, takeTheirs, getStatus: loadStatusSafe };
}

export type DeviceSyncRunner = ReturnType<typeof createDeviceSyncRunner>;
