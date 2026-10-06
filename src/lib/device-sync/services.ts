import { API_DATA_RETENTION_DAYS } from "@/lib/youtube-data-policy/contracts";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createClient } from "@libsql/client";
import { copyDatabaseConsistently } from "@/lib/db-backup";
import { exportHandoff, importHandoff, isDeviceInRecoveryMode, RecoveryModeError } from "@/lib/device-handoff";
import { getOperationLock, OperationLockError, releaseStaleExportLock } from "@/lib/operation-lock";
import {
  addLineageAncestorsIfHeadUnchanged,
  computeFileContentFingerprint,
  diffTransferredContent,
  hasUnfinishedBatch,
  hasUnpublishedLocalChanges,
  isFastForwardOf,
  listSnapshotIdsStrict,
  migrateStagedCopy,
  readLineageFile,
  readLineageState,
  readManifestFromDir,
  SnapshotError,
  verifySnapshotForImport,
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
  DIVERGENCE_SECTIONS,
  divergenceSectionOf,
  EMPTY_DEVICE_SYNC_STATUS,
  TAKE_THEIRS_BACKUP_PREFIX,
  type DecisionInput,
  type DivergencePreview,
  type DivergenceSection,
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
  /** Phase 13 (owner msg 1139): own snapshots created before this are removed even within `keep`
   * (except the head) -- they hold other channels' YouTube API data past its 30-day limit. */
  olderThan?: Date;
}): Promise<string[]> {
  const keep = params.keep ?? DEVICE_SYNC_KEEP_OWN_SNAPSHOTS;
  const own = params.snapshots
    .filter((s) => s.sourceDeviceId === params.deviceId)
    .sort((a, b) => b.generation - a.generation || b.createdAt.localeCompare(a.createdAt));
  const tooOld = (s: SnapshotEntry) => params.olderThan !== undefined && Date.parse(s.createdAt) < params.olderThan.getTime();
  const removed: string[] = [];
  for (const [index, s] of own.entries()) {
    if (index < keep && !tooOld(s)) continue;
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
// Background writes (false divergences, owner Telegram 2026-10-06)
// ---------------------------------------------------------------------------------------------

export type BackgroundWriteVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether an AUTOMATIC write to transferred data (e.g. the dashboard's Market Intelligence
 * refresh) may run now, given a just-finished tick. It may once this computer has caught up with
 * the other one (or there is no sync); otherwise its new rows would start a second branch next to
 * data the other computer already published -- the 5 October conflict. Never applies to an action
 * a person starts on purpose.
 */
export function backgroundWriteVerdict(status: DeviceSyncStatus, nowMs: number): BackgroundWriteVerdict {
  // Something from another computer is arriving right now. An older pending entry is a stuck
  // transfer with its own notice, and must not stop the refresh for good (review round 1, #5).
  const arriving = Object.values(status.pendingSince ?? {}).some((since) => nowMs - since < DEVICE_SYNC_TRANSFER_GRACE_MS);
  if (arriving) return { allowed: false, reason: "data from another computer is still arriving in the sync folder" };
  switch (status.state) {
    case "busy":
      return { allowed: false, reason: `device sync is paused: ${status.busyReason ?? "another operation is running"}` };
    case "folder_unreachable":
      return { allowed: false, reason: "the sync folder is not reachable, so the other computer's data cannot be checked" };
    case "attention":
      return status.notices.some((n) => n.kind === "divergence")
        ? { allowed: false, reason: "the two computers' data differs; choose a version in the Merge tab first" }
        : { allowed: true };
    default:
      return { allowed: true };
  }
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
  /** True while this process is running a long server-side write (e.g. "Fix all"). Such a run calls the
   * device-availability gate before every video, and an automatic export holds the operation lock, so
   * an export started mid-run would abort it. Optional: omitted = never blocks. */
  hasActiveLocalOperation?: () => boolean;
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
    readonly reason: "busy" | "local_changed" | "nothing_to_export" | "folder_unreachable" | "batch_in_progress" = "busy"
  ) {
    super(message);
  }
}

/**
 * While this computer's data holds an unfinished Batch (`hasUnfinishedBatch`: `RUNNING`, or rows
 * `AWAITING_EXECUTION`/`APPLYING`/`UNKNOWN`), automatic sync pauses in BOTH directions with this
 * notice: an export would hand another computer an executable copy without this computer's
 * per-video locks; an import would replace the batch tables under a Prepare/Execute. The check uses
 * transferred data, not the device-local locks, which some abort paths leak (RISK-90). It cannot
 * tell where the Batch was started, so the notice gives no "execute it" advice.
 */
const BATCH_PAUSES_IMPORT_MESSAGE =
  "This computer's data holds an unfinished Batch (prepared, running, or interrupted), so automatic sync is paused in both directions until it is finished. If it was started on another computer, finish it there. Manual export/import in the Merge tab still works.";

const apiDataExpiryCutoff = (nowMs: number) => new Date(nowMs - API_DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000);

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
    // Owner, Telegram 2026-10-06: the old "does not continue this computer's history" read as if only
    // the other computer had changed anything; in practice both had (this one had published already).
    message: multipleTips
      ? "Several other computers changed Batches/audit/Research/Decisions data differently from this computer. Choose which version to keep."
      : localDirty
        ? "Both computers changed Batches/audit/Research/Decisions data since they last agreed, and the data differs. Choose which version to keep."
        : "Both computers changed Batches/audit/Research/Decisions data since they last agreed (this computer's version is already published), and the data differs. Choose which version to keep.",
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
  async function busyReason(): Promise<{ reason: string; recovery: boolean; batch?: boolean } | null> {
    // A lock left by a killed export would otherwise block every mutation until cleared by hand.
    await releaseStaleExportLock(deps.client).catch(() => false);
    if (await getOperationLock(deps.client)) return { reason: "an export/import/migration is in progress", recovery: false };
    if (await isDeviceInRecoveryMode(deps.client)) return { reason: "this computer is in recovery mode", recovery: true };
    if (await hasUnfinishedBatch(deps.client)) return { reason: "an unfinished Batch is in this computer's data", recovery: false, batch: true };
    if (deps.hasActiveLocalOperation?.()) return { reason: "a server-side write operation is running", recovery: false };
    return null;
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
      refuseUnresolvedExecution: true,
      assertStillSafe: async () => {
        // Re-checked inside the lock: the drive may have been ejected since the tick's own check
        // (round 6) -- e.g. during a "take theirs" import, before its marker export.
        if (!(await isExistingDirectory(config.folder))) {
          throw new SyncAbort("the sync folder is not reachable", "folder_unreachable");
        }
        if (await hasUnfinishedBatch(deps.client)) throw new SyncAbort(BATCH_PAUSES_IMPORT_MESSAGE, "batch_in_progress");
        if (deps.hasActiveLocalOperation?.()) throw new SyncAbort("a server-side write operation is running", "busy");
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
        olderThan: apiDataExpiryCutoff(now()),
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
        if (await hasUnfinishedBatch(deps.client)) throw new SyncAbort(BATCH_PAUSES_IMPORT_MESSAGE, "batch_in_progress");
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
   * False divergences (owner, Telegram 2026-10-06, msgs 1758/1764): the content fingerprint of a peer
   * snapshot as THIS build would import it -- verified, copied and migrated exactly like
   * `importHandoff` stages it, never ATTACHed in the shared folder. A snapshot never changes, so the
   * result is kept per id; `null` (cannot be compared: needs a newer schema, unreadable) is kept too,
   * so a standing divergence does not copy the whole file again every tick. A transient error (still
   * transferring) is not kept and is retried next tick.
   */
  /** Runs `fn` on a private copy of a peer snapshot's data, verified (checksums), copied and
   * migrated to this build exactly as `importHandoff` stages it -- never ATTACHed in the shared
   * folder, where Syncthing would pick up any side file. The copy is always removed. */
  async function withStagedPeerCopy<T>(folder: string, snapshotId: string, fn: (stagedPath: string) => Promise<T>): Promise<T> {
    const snapshotDir = path.join(folder, snapshotId);
    await mkdir(deps.workingDir, { recursive: true });
    const workingCopyPath = path.join(deps.workingDir, `compare-${randomUUID()}.db`);
    try {
      await verifySnapshotForImport({
        snapshotDir,
        localLineage: await readLineageState(deps.client),
        acceptDivergentLineage: true,
      });
      const snapshotDbClient = createClient({ url: `file:${path.join(snapshotDir, "data.db")}` });
      try {
        await copyDatabaseConsistently(snapshotDbClient, workingCopyPath);
      } finally {
        snapshotDbClient.close();
      }
      await migrateStagedCopy(workingCopyPath);
      return await fn(workingCopyPath);
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) await rm(`${workingCopyPath}${suffix}`, { force: true }).catch(() => {});
    }
  }

  /**
   * False divergences (owner, Telegram 2026-10-06, msgs 1758/1764): the content fingerprint of a peer
   * snapshot as THIS build would import it. A snapshot never changes, so the result is kept per id.
   * `null` is kept only when this build can never read it (a newer schema); any other failure
   * (still transferring, a full disk, a busy file) is retried next tick (review round 1, #7).
   */
  const stagedFingerprints = new Map<string, string | null>();
  async function stagedFingerprintOf(folder: string, snapshotId: string): Promise<string | null> {
    if (stagedFingerprints.has(snapshotId)) return stagedFingerprints.get(snapshotId) ?? null;
    try {
      const fingerprint = await withStagedPeerCopy(folder, snapshotId, (stagedPath) =>
        computeFileContentFingerprint(deps.client, stagedPath)
      );
      stagedFingerprints.set(snapshotId, fingerprint);
      return fingerprint;
    } catch (error) {
      if (error instanceof SchemaVersionError) stagedFingerprints.set(snapshotId, null);
      return null;
    }
  }

  /**
   * False divergences (BL-139, owner Telegram 2026-10-06; reworked after review round 1): another
   * computer's conflicting branch that holds EXACTLY the content recorded with this device's head
   * (both computers applied the same update, or two resolutions picked the same data) contains
   * nothing this device lacks. It is recorded as an ancestor of the head -- head, data and
   * fingerprint unchanged, so nothing can be lost and every device keeps its OWN snapshot as head
   * (retention protects it). This device's next export then lists that branch among its ancestors,
   * so the other computer fast-forwards. Returns whether anything was recorded.
   */
  async function absorbIdenticalTips(folder: string, deviceId: string, snapshots: SnapshotEntry[]): Promise<boolean> {
    const lineage = await readLineageState(deps.client);
    if (!lineage.lastSnapshotId || !lineage.contentFingerprint) return false;
    const extra: string[] = [];
    for (const tip of await peerTips(deviceId, snapshots)) {
      if (tip.schemaVersion > deps.currentSchemaVersion) continue;
      if ((await stagedFingerprintOf(folder, tip.snapshotId)) !== lineage.contentFingerprint) continue;
      extra.push(tip.snapshotId, ...ancestryOf(tip.snapshotId, snapshots));
    }
    if (extra.length === 0) return false;
    return addLineageAncestorsIfHeadUnchanged(deps.client, lineage.lastSnapshotId, extra);
  }

  /**
   * A clean device that sees SEVERAL conflicting tips which all hold the same data (two other
   * computers settled an identical fork; review round 1, #2): import the newest one that continues
   * this device's history, like any fast-forward. The next tick absorbs the others.
   */
  async function identicalTipToImport(folder: string, deviceId: string, snapshots: SnapshotEntry[]): Promise<SnapshotEntry | null> {
    const tips = await peerTips(deviceId, snapshots);
    if (tips.length < 2 || tips.some((t) => t.schemaVersion > deps.currentSchemaVersion)) return null;
    const fingerprints = await Promise.all(tips.map((t) => stagedFingerprintOf(folder, t.snapshotId)));
    if (fingerprints.some((f) => !f || f !== fingerprints[0])) return null;
    const local = { lastSnapshotId: (await readLineageState(deps.client)).lastSnapshotId };
    return (
      tips
        .filter((t) => isFastForwardOf(t, t.ancestors, local))
        .sort((x, y) => y.generation - x.generation || x.snapshotId.localeCompare(y.snapshotId))[0] ?? null
    );
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
          : busy.batch
            ? [{ kind: "batch_in_progress", message: BATCH_PAUSES_IMPORT_MESSAGE }]
            : status.notices;
        return finish({ ...status, state: "busy", busyReason: busy.reason, notices });
      }

      const scanned = await scanSnapshotFolder(folder);
      const { unreadable } = scanned;
      status = withPending(status, previousPending, unreadable);
      const lineage = await readLineageState(deps.client);
      // Phase 13 (owner msg 1139): a quiet device's own old snapshots must not keep expired YouTube
      // API data in the sync folder until its next export. Housekeeping; never fails the tick.
      const aged = await pruneOwnSnapshots({
        folder,
        deviceId: config.deviceId,
        headSnapshotId: lineage.lastSnapshotId,
        snapshots: scanned.snapshots,
        keep: Number.MAX_SAFE_INTEGER,
        olderThan: apiDataExpiryCutoff(now()),
      }).catch(() => [] as string[]);
      const snapshots = scanned.snapshots.filter((s) => !aged.includes(s.snapshotId));
      const localDirty = await hasUnpublishedLocalChanges(deps.client);
      const unsupported = new Set(
        status.unsupportedForSchemaVersion === deps.currentSchemaVersion ? (status.unsupportedSnapshotIds ?? []) : []
      );
      const decide = async () => {
        const current = await readLineageState(deps.client);
        return decideSyncAction({
          deviceId: config.deviceId,
          currentSchemaVersion: deps.currentSchemaVersion,
          local: { lastSnapshotId: current.lastSnapshotId, ancestors: current.ancestors ?? [] },
          localDirty,
          // A snapshot this build already failed to migrate is reported as "update the app", never
          // re-imported every tick (plan §3.4).
          snapshots: snapshots.map((s) => (unsupported.has(s.snapshotId) ? { ...s, schemaVersion: Number.MAX_SAFE_INTEGER } : s)),
        });
      };
      let decision = await decide();
      // BL-139: a "conflict" whose other side holds this head's own data is no conflict; settle it
      // and decide again (an export or idle follows). Comparison failures fall through to asking.
      if (decision.kind === "divergence") {
        const absorbed = await absorbIdenticalTips(folder, config.deviceId, snapshots).catch(() => false);
        if (absorbed) {
          status = { ...status, lastIdenticalSettledAt: new Date(now()).toISOString() };
          decision = await decide();
        }
      }
      if (decision.kind === "divergence" && decision.multipleTips && !localDirty) {
        const pick = await identicalTipToImport(folder, config.deviceId, snapshots).catch(() => null);
        if (pick) decision = { kind: "import", snapshot: pick };
      }

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
          if (await hasUnfinishedBatch(deps.client)) {
            return finish({
              ...status,
              state: "busy",
              busyReason: "an unfinished Batch is in this computer's data",
              notices: [{ kind: "batch_in_progress", message: BATCH_PAUSES_IMPORT_MESSAGE }, ...stuckNotice(status)],
            });
          }
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
      if (error instanceof SyncAbort && error.reason === "folder_unreachable") {
        return finish({ ...status, state: "folder_unreachable", notices: [] });
      }
      if (error instanceof SyncAbort && error.reason === "batch_in_progress") {
        return finish({
          ...status,
          state: "busy",
          busyReason: "an unfinished Batch is in this computer's data",
          notices: [{ kind: "batch_in_progress", message: BATCH_PAUSES_IMPORT_MESSAGE }],
        });
      }
      if (error instanceof SnapshotError && error.code === "snapshot_execution_in_flight") {
        return finish({
          ...status,
          state: "busy",
          busyReason: "this computer's data holds an unfinished Batch",
          notices: [{ kind: "batch_in_progress", message: BATCH_PAUSES_IMPORT_MESSAGE }],
        });
      }
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
    let manifest: Awaited<ReturnType<typeof exportNow>>;
    try {
      manifest = await exportNow(config, {
      supersede: { snapshotId: snapshot.snapshotId, generation, ancestors: [...replaced] },
      supersedes: tips.map((t) => t.snapshotId),
      requireDirty: false,
    });
    } catch (error) {
      if (error instanceof SyncAbort && error.reason === "folder_unreachable") {
        throw new DeviceSyncError("device_sync_folder_unreachable", "The sync folder is not reachable (is the drive connected?).");
      }
      if (error instanceof SyncAbort) throw new DeviceSyncError("device_sync_busy", `Cannot sync now: ${error.message}.`);
      throw error;
    }
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
    if (await hasUnfinishedBatch(deps.client)) throw new DeviceSyncError("device_sync_busy", BATCH_PAUSES_IMPORT_MESSAGE);
    let result: Awaited<ReturnType<typeof importNow>>;
    try {
      result = await importNow(config.folder, snapshotId, { acceptDivergentLineage: true, requireClean: false });
    } catch (error) {
      if (error instanceof SyncAbort) throw new DeviceSyncError("device_sync_busy", error.message);
      throw error;
    }

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

  /**
   * Divergence preview for the Merge tab (owner, Telegram 2026-10-06, msg 1758: "show between what
   * and what I am choosing"): the current conflicting peer tip, this computer's position, the newest
   * snapshot both histories share, and per transferred table what only this computer has, what only
   * the other has, and what both have but differently. Read-only: nothing is published or replaced.
   */
  async function divergencePreviewUnlocked(snapshotId: string): Promise<DivergencePreview> {
    const { config, snapshot, snapshots, tips } = await requireCurrentPeerTip(snapshotId);
    const lineage = await readLineageState(deps.client);
    const tables = await withStagedPeerCopy(config.folder, snapshotId, (stagedPath) => diffTransferredContent(deps.client, stagedPath));
    const known = ancestryOf(lineage.lastSnapshotId, snapshots, lineage.ancestors ?? []);
    if (lineage.lastSnapshotId) known.add(lineage.lastSnapshotId);
    const peerAncestry = ancestryOf(snapshot.snapshotId, snapshots);
    const base = snapshots
      .filter((s) => known.has(s.snapshotId) && peerAncestry.has(s.snapshotId))
      .sort((x, y) => y.generation - x.generation)[0];
    const sections = new Map<DivergenceSection, { onlyHere: number; onlyThere: number; changed: number }>();
    for (const section of DIVERGENCE_SECTIONS) sections.set(section, { onlyHere: 0, onlyThere: 0, changed: 0 });
    for (const t of tables) {
      const total = sections.get(divergenceSectionOf(t.table)) as { onlyHere: number; onlyThere: number; changed: number };
      total.onlyHere += t.onlyHere;
      total.onlyThere += t.onlyThere;
      total.changed += t.changed;
    }
    const status = await loadStatusSafe();
    return {
      peer: {
        snapshotId: snapshot.snapshotId,
        sourceDeviceId: snapshot.sourceDeviceId,
        createdAt: snapshot.createdAt,
        generation: snapshot.generation,
      },
      local: {
        deviceId: config.deviceId,
        headSnapshotId: lineage.lastSnapshotId,
        lastExportAt: status.lastExportAt,
        unpublishedChanges: await hasUnpublishedLocalChanges(deps.client),
      },
      peerTips: tips.length,
      commonBase: base ? { snapshotId: base.snapshotId, createdAt: base.createdAt, sourceDeviceId: base.sourceDeviceId } : null,
      sections: [...sections.entries()].map(([section, totals]) => ({ section, ...totals })),
      tables: tables
        .filter((t) => t.onlyHere + t.onlyThere + t.changed > 0)
        .map((t) => ({ ...t, section: divergenceSectionOf(t.table) })),
    };
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
    /** One tick now (it imports the other computer's newer data first, when there is any), then the
     * verdict for an automatic write. */
    syncBeforeBackgroundWrite: (): Promise<BackgroundWriteVerdict> =>
      serialize(async () => {
        const status = await tick();
        const verdict = backgroundWriteVerdict(status, now());
        const backgroundWritesPausedReason = verdict.allowed ? null : verdict.reason;
        if ((status.backgroundWritesPausedReason ?? null) !== backgroundWritesPausedReason) {
          await deps.saveStatus({ ...status, backgroundWritesPausedReason }).catch(() => {});
        }
        return verdict;
      }),
    keepMine: (snapshotId: string) => serialize(() => keepMineUnlocked(snapshotId)),
    takeTheirs: (snapshotId: string) => serialize(() => takeTheirsUnlocked(snapshotId)),
    divergencePreview: (snapshotId: string) => serialize(() => divergencePreviewUnlocked(snapshotId)),
    getStatus: loadStatusSafe,
  };
}

export type DeviceSyncRunner = ReturnType<typeof createDeviceSyncRunner>;
