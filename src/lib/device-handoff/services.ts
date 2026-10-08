import { purgeExpiredApiDataWithinTransaction } from "@/lib/youtube-data-policy";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createLibsqlClient } from "@/lib/libsql-client";
import { copyDatabaseConsistently } from "@/lib/db-backup";
import { withOperationLock } from "@/lib/operation-lock";
import {
  applySnapshotToDatabase,
  computeContentFingerprint,
  computeFileContentFingerprint,
  SnapshotError,
  exportSnapshot,
  migrateStagedCopy,
  readLineageState,
  scanFileForUnresolvedExecutionState,
  scanForUnresolvedExecutionState,
  verifySnapshotForImport,
  writeLineageState,
} from "@/lib/snapshot";
import { RecoveryModeError, type ExportHandoffResult, type ImportHandoffResult, type SqlExecutor } from "./contracts";

export { RecoveryModeError };

/** Backup prefix for an import that replaces this device's own head by another computer's "keep
 * mine" decision. Never pruned automatically. */
export const SUPERSEDED_BACKUP_PREFIX = "pre-superseded";

// The pre-mutation gate lives in `src/lib/device-mutation-gate` (architecture audit M5); re-exported
// here unchanged for this feature's existing callers.
import { isDeviceInRecoveryMode } from "@/lib/device-mutation-gate";
export { assertDeviceAvailableForMutation, assertNotInRecoveryMode, isDeviceInRecoveryMode } from "@/lib/device-mutation-gate";

async function recordHandoffLog(
  client: SqlExecutor,
  entry: { direction: "export" | "import"; snapshotId: string; detail: Record<string, unknown> }
): Promise<void> {
  await client.execute({
    sql:
      "INSERT INTO handoff_log (id, direction, snapshot_id, recorded_at, detail_json) VALUES (?, ?, ?, ?, ?)",
    args: [randomUUID(), entry.direction, entry.snapshotId, new Date().toISOString(), JSON.stringify(entry.detail)],
  });
}

/**
 * "Finish work on this device / Export handoff" (task §3E). Never claims to prove the other
 * (or this) device's process has stopped -- it records that export completed on this device,
 * nothing more.
 */
export async function exportHandoff(params: {
  client: SqlExecutor;
  snapshotsDir: string;
  deviceId: string;
  schemaVersion: number;
  /** "Keep this computer's data" (DEVICE_AUTO_SYNC_PLAN.md §3.6). */
  supersede?: { snapshotId: string; generation: number; ancestors: string[] };
  /** Snapshots this export replaces by a human decision (written to `lineage.json`). */
  supersedes?: string[];
  /** `false`: never create the snapshots folder itself (automatic device sync). */
  createSnapshotsDir?: boolean;
  /** Automatic device sync: never publish a copy that caught a YouTube write mid-flight. */
  refuseUnresolvedExecution?: boolean;
  /** Automatic sync (§3.3): re-checked inside the operation lock before anything is written. */
  assertStillSafe?: () => Promise<void>;
}): Promise<ExportHandoffResult> {
  return withOperationLock(params.client, "export", async () => {
    if (params.assertStillSafe) await params.assertStillSafe();
    const unresolvedAtExportTime = await scanForUnresolvedExecutionState(params.client);
    const manifest = await exportSnapshot({
      client: params.client,
      snapshotsDir: params.snapshotsDir,
      deviceId: params.deviceId,
      schemaVersion: params.schemaVersion,
      supersede: params.supersede,
      supersedes: params.supersedes,
      createSnapshotsDir: params.createSnapshotsDir,
      refuseUnresolvedExecution: params.refuseUnresolvedExecution,
    });
    await recordHandoffLog(params.client, {
      direction: "export",
      snapshotId: manifest.snapshotId,
      detail: { unresolvedCount: unresolvedAtExportTime.length },
    });
    return { manifest, unresolvedAtExportTime };
  });
}

/**
 * "Continue work on this device / Import handoff". Full procedure per the plan's decision D/E:
 * lock -> verify -> backup current live DB -> migrate a private working copy of the snapshot's
 * data.db (never the live DB's schema directly) -> read-only unresolved-execution scan on that
 * working copy -> merge into the live DB inside one transaction -> advance this device's own
 * lineage -> record the handoff. A duplicate-of-current snapshot is a safe no-op (AC-SNAP-07) --
 * it verifies and returns without touching the live DB at all.
 */
export async function importHandoff(params: {
  liveClient: SqlExecutor;
  snapshotDir: string;
  migrationBackupsDir: string;
  workingDir: string;
  /** "Take the other computer's data" (DEVICE_AUTO_SYNC_PLAN.md §3.6): explicit human choice. */
  acceptDivergentLineage?: boolean;
  /**
   * Automatic sync (§3.3): re-checked INSIDE the operation lock, immediately before the live DB is
   * touched. Throwing aborts the import with the live DB unchanged (AC-AS-07).
   */
  assertStillSafe?: (context: { liveFingerprint: string }) => Promise<void>;
  /** File-name prefix of the pre-import backup. Automatic imports use their own prefix so that
   * retention can prune exactly those and never a manual or "take theirs" backup. */
  backupPrefix?: string;
}): Promise<ImportHandoffResult> {
  return withOperationLock(params.liveClient, "import", async () => {
    // A device already in restricted recovery mode must not import again: applySnapshotToDatabase
    // (below, via the merge step) unconditionally replaces `batch_ledger_rows` wholesale, which
    // would silently discard this device's own unresolved-execution evidence -- exactly what
    // UNRESOLVED_EXECUTION_STATUSES's own contract says must never happen (found by independent
    // review; src/proxy.ts's device-handoff exemption only avoids a lock self-deadlock, it was
    // never meant to also bypass this check, so it is enforced here instead, directly on the
    // path that would actually cause the harm). The device must leave recovery mode via Phase
    // 5's existing reconciliation mechanism (RISK-09 §0.F) before another import can proceed.
    if (await isDeviceInRecoveryMode(params.liveClient)) {
      const unresolved = await scanForUnresolvedExecutionState(params.liveClient);
      throw new RecoveryModeError(unresolved);
    }

    const localLineage = await readLineageState(params.liveClient);
    const { manifest, isDuplicateOfCurrent, ancestors, supersedes } = await verifySnapshotForImport({
      snapshotDir: params.snapshotDir,
      localLineage,
      acceptDivergentLineage: params.acceptDivergentLineage,
    });

    if (isDuplicateOfCurrent) {
      return { status: "duplicate_noop", manifest };
    }

    // Backup-before-migrate (decision 1's mechanism, reused): the live DB is never mutated
    // below without a fresh, verified recovery point already on disk.
    // When the incoming snapshot deliberately replaces this device's own head (another computer's
    // "keep mine"), this device's divergent data survives only in this backup -- so it gets a
    // prefix no automatic retention ever prunes (review round 2).
    const localHeadSuperseded = localLineage.lastSnapshotId !== null && supersedes.includes(localLineage.lastSnapshotId);
    const backupPrefix = localHeadSuperseded ? SUPERSEDED_BACKUP_PREFIX : (params.backupPrefix ?? "pre-import");
    const backupPath = path.join(params.migrationBackupsDir, `${backupPrefix}-${Date.now()}-${randomUUID().slice(0, 8)}.db`);
    await copyDatabaseConsistently(params.liveClient, backupPath);
    // What the backup holds, so the merge can verify (inside its transaction) that nothing was
    // written in between -- a write the backup lacks would otherwise be overwritten untraceably.
    const backupFingerprint = await computeFileContentFingerprint(params.liveClient, backupPath);

    // Never migrate the live DB's schema via the snapshot -- bring a private working copy of
    // the snapshot's own data.db up to this build's version instead (reuses
    // initializeDatabaseSchema unchanged, including its own reject-newer guarantee).
    const workingCopyPath = path.join(params.workingDir, `import-${randomUUID()}.db`);
    const snapshotDbClient = createLibsqlClient({
      url: `file:${path.join(params.snapshotDir, "data.db")}`,
    });
    try {
      await copyDatabaseConsistently(snapshotDbClient, workingCopyPath);
    } finally {
      snapshotDbClient.close();
    }

    // RISK-27 (docs/TECHNICAL_DEBT.md): this backup exists to protect a live-DB mutation that
    // is about to happen -- if the import fails before that mutation ever occurs (e.g.
    // migrateStagedCopy rejects an incompatible schema version), the backup protects nothing
    // and would otherwise leak one full extra DB-copy file per failed attempt, unbounded, on
    // every retry against the same incompatible snapshot.
    let liveDbMutated = false;
    try {
      await migrateStagedCopy(workingCopyPath);

      const unresolved = await scanFileForUnresolvedExecutionState(workingCopyPath);

      // applySnapshotToDatabase owns its own transaction (ATTACH cannot happen inside an already-open
      // one). Everything that must not race another connection's write runs INSIDE it, under
      // `BEGIN IMMEDIATE` (review round 2): the no-change-since-backup check and the caller's own
      // re-check before the merge; the fingerprint and the lineage pointer after it, before COMMIT.
      await applySnapshotToDatabase(params.liveClient, workingCopyPath, {
        beforeMerge: async () => {
          if ((await computeContentFingerprint(params.liveClient)) !== backupFingerprint) {
            throw new SnapshotError(
              "snapshot_local_changed_during_import",
              "Local data changed while the import was being prepared; nothing was replaced. Try again."
            );
          }
          // Live content equals the backup's, so its fingerprint is already known -- no second
          // full scan while holding the write lock (review round 3).
          if (params.assertStillSafe) await params.assertStillSafe({ liveFingerprint: backupFingerprint });
        },
        afterMerge: async () => {
          // Owner msg 1139, item 3: rows that already expired under the YouTube API 30-day rule never
          // come back through an import -- dropped here, inside the merge, before the fingerprint.
          await purgeExpiredApiDataWithinTransaction(params.liveClient);
          await writeLineageState(params.liveClient, {
            lastSnapshotId: manifest.snapshotId,
            lastGeneration: manifest.generation,
            contentFingerprint: await computeContentFingerprint(params.liveClient),
            ancestors: [manifest.parentSnapshotId, ...(ancestors ?? [])].filter(
              (id, index, all): id is string => id !== null && all.indexOf(id) === index
            ),
          });
        },
      });
      liveDbMutated = true;
      await recordHandoffLog(params.liveClient, {
        direction: "import",
        snapshotId: manifest.snapshotId,
        detail: { unresolvedCount: unresolved.length },
      });

      if (unresolved.length > 0) {
        return { status: "activated_recovery_mode", manifest, unresolved };
      }
      return { status: "activated_normal", manifest };
    } finally {
      // The working copy is a throwaway, private intermediate -- never the source of truth for
      // anything after this function returns (the live DB and the published snapshot are).
      // Found by independent review that an earlier version of this function never deleted it,
      // leaking one full database-copy file per import indefinitely. Deleting the main file and
      // both possible WAL-mode sidecars is a best-effort cleanup: a failure here must not mask
      // the import's own real result (success or a genuine error) above.
      await rm(workingCopyPath, { force: true }).catch(() => {});
      await rm(`${workingCopyPath}-wal`, { force: true }).catch(() => {});
      await rm(`${workingCopyPath}-shm`, { force: true }).catch(() => {});
      // RISK-27: the live DB was never actually mutated, so this backup protects nothing --
      // remove it too, rather than leaking it on every failed/incompatible import attempt.
      if (!liveDbMutated) {
        await rm(backupPath, { force: true }).catch(() => {});
      }
    }
  });
}

/**
 * Read-only/informational operator action (the tightened correction): records that the
 * diagnostics were reviewed. Structurally cannot change any row's status, authorize retry, or
 * lift the recovery-mode gate -- it does not call anything that writes to `batch_ledger_rows`,
 * and `assertDeviceAvailableForMutation`/`isDeviceInRecoveryMode` never read this table at all.
 */
export async function acknowledgeRecoveryDiagnostics(
  client: SqlExecutor,
  params: { note?: string } = {}
): Promise<{ affectedBatches: Awaited<ReturnType<typeof scanForUnresolvedExecutionState>> }> {
  const affectedBatches = await scanForUnresolvedExecutionState(client);
  await client.execute({
    sql:
      "INSERT INTO recovery_acknowledgements (id, acknowledged_at, affected_batches_json, note) VALUES (?, ?, ?, ?)",
    args: [randomUUID(), new Date().toISOString(), JSON.stringify(affectedBatches), params.note ?? null],
  });
  return { affectedBatches };
}
