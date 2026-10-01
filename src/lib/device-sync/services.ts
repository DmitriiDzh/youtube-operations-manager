import path from "node:path";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
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

  // The SAME rule `verifySnapshotForImport` enforces (recorded `lineage.json` ancestry or a direct
  // parent) -- never a looser one, or the import would be refused after the decision (AC-AS-14).
  const local = { lastSnapshotId: head };
  if (!input.localDirty) {
    if (isFastForwardOf(tip, tip.ancestors, local)) return { kind: "import", snapshot: tip };
    // A chain from an older build (no `lineage.json`): catch up one verifiable step at a time --
    // the newest of the tip's own ancestors that is a direct fast-forward of the local head.
    const tipAncestry = ancestryOf(tip.snapshotId, input.snapshots);
    if (head !== null && tipAncestry.has(head)) {
      const step = newer
        .filter((s) => tipAncestry.has(s.snapshotId) && isFastForwardOf(s, s.ancestors, local))
        .sort((a, b) => b.generation - a.generation)[0];
      if (step) {
        return step.schemaVersion > input.currentSchemaVersion
          ? { kind: "update_app", snapshot: step }
          : { kind: "import", snapshot: step };
      }
    }
  }
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
        ...(await readLineageFile(dir, manifest).then((file) => ({
          ancestors: file?.ancestors ?? null,
          supersedes: file?.supersedes ?? [],
        }))),
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

async function isExistingDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

class SyncAbort extends Error {
  constructor(
    message: string,
    readonly reason: "busy" | "local_changed" | "nothing_to_export" = "busy"
  ) {
    super(message);
  }
}

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
    options: {
      supersede?: { snapshotId: string; generation: number; ancestors: string[] };
      supersedes?: string[];
      requireDirty?: boolean;
    } = {}
  ) {
    const { supersede, supersedes, requireDirty = true } = options;
    const result = await exportHandoff({
      client: deps.client,
      snapshotsDir: config.folder,
      deviceId: config.deviceId,
      schemaVersion: deps.currentSchemaVersion,
      supersede,
      supersedes,
      createSnapshotsDir: false,
      assertStillSafe: async () => {
        // Re-checked inside the lock: the drive may have been ejected since the tick's own check
        // (round 6) -- e.g. during a "take theirs" import, before its marker export.
        if (!(await isExistingDirectory(config.folder))) throw new SyncAbort("the sync folder is not reachable");
        const active = await hasActiveExecution(deps.client);
        if (active) throw new SyncAbort(active);
        if (requireDirty && !(await hasUnpublishedLocalChanges(deps.client))) {
          throw new SyncAbort("nothing to export", "nothing_to_export");
        }
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
      assertStillSafe: async ({ liveFingerprint }) => {
        const active = await hasActiveExecution(deps.client);
        if (active) throw new SyncAbort(active);
        // AC-AS-07: a local change that landed after the decision aborts the automatic import.
        if (mode.requireClean && (await hasUnpublishedLocalChanges(deps.client, liveFingerprint))) {
          throw new SyncAbort("local data changed", "local_changed");
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
      // An automatic action never CREATES the sync folder (pre-merge check): with an external drive
      // unplugged, or mounted under another name, creating the configured path would publish
      // snapshots to a local folder no other computer sees. Wait until it exists again.
      if (!(await isExistingDirectory(folder))) {
        return finish({ ...status, state: "folder_unreachable", notices: [] });
      }

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
      const unsupported = new Set(
        status.unsupportedForSchemaVersion === deps.currentSchemaVersion ? (status.unsupportedSnapshotIds ?? []) : []
      );
      const decision = decideSyncAction({
        deviceId: config.deviceId,
        currentSchemaVersion: deps.currentSchemaVersion,
        local: { lastSnapshotId: lineage.lastSnapshotId, ancestors: lineage.ancestors ?? [] },
        localDirty,
        // A snapshot this build already failed to migrate is reported as "update the app", never
        // re-imported every tick (plan §3.4).
        snapshots: snapshots.map((s) => (unsupported.has(s.snapshotId) ? { ...s, schemaVersion: Number.MAX_SAFE_INTEGER } : s)),
      });

      const wouldExport = decision.kind === "export" || (decision.kind === "divergence" && decision.localDirty);
      if (options.exportOnly && !wouldExport) {
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

        case "divergence": {
          let next: DeviceSyncStatus = {
            ...status,
            state: "attention",
            notices: [divergenceNotice(decision.snapshot, decision.localDirty, decision.multipleTips), ...stuckNotice(status)],
          };
          // Still publish this computer's own unpublished changes (on its own branch; nothing is
          // overwritten anywhere), so the OTHER computer sees the conflict and can resolve it too,
          // instead of only the computer that happened to look second.
          const lastExportMs = status.lastExportAt ? Date.parse(status.lastExportAt) : 0;
          if (decision.localDirty && (options.force || now() - lastExportMs >= DEVICE_SYNC_MIN_EXPORT_INTERVAL_MS)) {
            const manifest = await exportNow({ deviceId: config.deviceId, folder });
            next = { ...next, lastExportAt: new Date(now()).toISOString(), lastExportSnapshotId: manifest.snapshotId };
          }
          return finish(next);
        }

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
            if (error instanceof SnapshotError && error.code === "snapshot_divergent_lineage") {
              // Verification disagreed with the decision: a human decides, with the buttons.
              return finish({
                ...status,
                state: "attention",
                notices: [divergenceNotice(decision.snapshot, false, false), ...stuckNotice(status)],
              });
            }
            // Local data changed after the decision (plan §3.4): that is a divergence now.
            if (
              (error instanceof SyncAbort && error.reason === "local_changed") ||
              (error instanceof SnapshotError && error.code === "snapshot_local_changed_during_import")
            ) {
              return finish({
                ...status,
                state: "attention",
                notices: [divergenceNotice(decision.snapshot, true, false), ...stuckNotice(status)],
              });
            }
            if (error instanceof SchemaVersionError) {
              return finish({
                ...status,
                state: "attention",
                unsupportedSnapshotIds: [...unsupported, decision.snapshot.snapshotId],
                unsupportedForSchemaVersion: deps.currentSchemaVersion,
                notices: [
                  {
                    kind: "update_app",
                    message: "The other computer's data needs a newer app version. Update the app on this computer.",
                    snapshotId: decision.snapshot.snapshotId,
                    sourceDeviceId: decision.snapshot.sourceDeviceId,
                  },
                ],
              });
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

  /** Other devices' snapshots that are not in the local history and not covered by another one. */
  async function peerTips(deviceId: string, snapshots: SnapshotEntry[]): Promise<SnapshotEntry[]> {
    const lineage = await readLineageState(deps.client);
    const known = ancestryOf(lineage.lastSnapshotId, snapshots, lineage.ancestors ?? []);
    if (lineage.lastSnapshotId) known.add(lineage.lastSnapshotId);
    const newer = snapshots.filter((s) => s.sourceDeviceId !== deviceId && !known.has(s.snapshotId));
    const covered = new Set<string>();
    for (const s of newer) for (const id of ancestryOf(s.snapshotId, snapshots)) covered.add(id);
    return newer.filter((s) => !covered.has(s.snapshotId));
  }

  /** The conflicting snapshot a resolution names, re-read from the folder and required to be a
   * CURRENT conflicting tip -- never any older snapshot from another device, and never trusted
   * from the request beyond its id (review round 2). */
  async function requireCurrentPeerTip(snapshotId: string) {
    const config = await deps.resolveConfig();
    if (!config.folder) throw new DeviceSyncError("device_sync_not_configured", "No sync folder is configured.");
    if (!(await isExistingDirectory(config.folder))) {
      throw new DeviceSyncError("device_sync_folder_unreachable", "The sync folder is not reachable (is the drive connected?).");
    }
    const { snapshots } = await scanSnapshotFolder(config.folder);
    const tips = await peerTips(config.deviceId, snapshots);
    const snapshot = tips.find((s) => s.snapshotId === snapshotId);
    if (!snapshot) {
      throw new DeviceSyncError(
        "device_sync_snapshot_not_found",
        "That snapshot from another computer is not in the sync folder, or is no longer the one in conflict. Refresh and choose again."
      );
    }
    return { config: { deviceId: config.deviceId, folder: config.folder }, snapshot, snapshots, tips };
  }

  /**
   * §3.6 "Keep this computer's data": publish the local state as a child of the other device's
   * snapshot, so that device fast-forwards to it. Every other conflicting tip currently in the
   * folder is folded into the ancestry too, so one decision settles all of them. Each replaced tip
   * is listed in `supersedes`, so the computer that loses keeps a never-pruned backup.
   * Explicit human action only.
   */
  async function keepMineUnlocked(snapshotId: string): Promise<DeviceSyncStatus> {
    const { config, snapshot, snapshots, tips } = await requireCurrentPeerTip(snapshotId);
    const busy = await busyReason();
    if (busy) throw new DeviceSyncError("device_sync_busy", `Cannot sync now: ${busy.reason}.`);
    const replaced = new Set<string>(ancestryOf(snapshot.snapshotId, snapshots));
    for (const tip of tips) {
      replaced.add(tip.snapshotId);
      for (const id of ancestryOf(tip.snapshotId, snapshots)) replaced.add(id);
    }
    replaced.delete(snapshot.snapshotId);
    const generation = Math.max(snapshot.generation, ...tips.map((t) => t.generation));
    const manifest = await exportNow(config, {
      supersede: { snapshotId: snapshot.snapshotId, generation, ancestors: [...replaced] },
      supersedes: tips.map((t) => t.snapshotId),
      requireDirty: false,
    });
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
   *
   * If this computer had already published its own now-abandoned branch, it then publishes the
   * adopted state once more with that branch as an ancestor (and in `supersedes`), so the other
   * computer sees a plain fast-forward and settles. Never by DELETING the branch from the shared
   * folder (review round 2): deletion propagates asynchronously and is indistinguishable from "not
   * arrived yet", so two opposite resolutions made at the same time left both computers "synced"
   * with swapped data. With markers, that race fails closed -- each computer sees the other's marker
   * as a conflict and asks again (RISK-89).
   */
  async function takeTheirsUnlocked(snapshotId: string): Promise<DeviceSyncStatus> {
    const { config, snapshot, snapshots } = await requireCurrentPeerTip(snapshotId);
    const busy = await busyReason();
    if (busy && !busy.recovery) throw new DeviceSyncError("device_sync_busy", `Cannot sync now: ${busy.reason}.`);
    const result = await importNow(config.folder, snapshotId, { acceptDivergentLineage: true, requireClean: false });

    const adoptedAncestry = ancestryOf(snapshotId, snapshots);
    const abandoned = snapshots
      .filter((s) => s.sourceDeviceId === config.deviceId && !adoptedAncestry.has(s.snapshotId))
      .map((s) => s.snapshotId);
    let markerId: string | null = null;
    if (abandoned.length > 0) {
      try {
        const marker = await exportNow(config, {
          supersede: { snapshotId, generation: snapshot.generation, ancestors: [...adoptedAncestry, ...abandoned] },
          supersedes: abandoned,
          requireDirty: false,
        });
        markerId = marker.snapshotId;
      } catch {
        // The import itself succeeded; the other computer keeps showing the conflict (fail closed).
      }
    }

    const status = await loadStatusSafe();
    const next: DeviceSyncStatus = {
      ...status,
      state: result.status === "activated_recovery_mode" ? "attention" : "imported",
      lastImportAt: new Date(now()).toISOString(),
      lastImportSnapshotId: snapshotId,
      ...(markerId ? { lastExportAt: new Date(now()).toISOString(), lastExportSnapshotId: markerId } : {}),
      notices:
        result.status === "activated_recovery_mode"
          ? [{ kind: "recovery_mode", message: "The imported data contains a YouTube write whose outcome is unknown. This computer is now in recovery mode." }]
          : [],
    };
    await deps.saveStatus(next).catch(() => {});
    return next;
  }

  // One action at a time per runner (review round 1): a tick and a resolution each load the status
  // at the start and save it at the end, so overlapping ones would overwrite each other's result.
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    tick: (options: { force?: boolean; exportOnly?: boolean } = {}) => serialize(() => tick(options)),
    keepMine: (snapshotId: string) => serialize(() => keepMineUnlocked(snapshotId)),
    takeTheirs: (snapshotId: string) => serialize(() => takeTheirsUnlocked(snapshotId)),
    getStatus: loadStatusSafe,
  };
}

export type DeviceSyncRunner = ReturnType<typeof createDeviceSyncRunner>;
