import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { copyDatabaseConsistently } from "@/lib/db-backup";
import { withOperationLock, OperationLockError } from "@/lib/operation-lock";
import {
  applySnapshotToDatabase,
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

/** Fresh, uncached: true iff `batch_ledger_rows` currently has any row whose execution outcome
 * is genuinely uncertain. Never a stored flag (see RecoveryModeError's own doc comment). */
export async function isDeviceInRecoveryMode(client: SqlExecutor): Promise<boolean> {
  const unresolved = await scanForUnresolvedExecutionState(client);
  return unresolved.length > 0;
}

export async function assertNotInRecoveryMode(client: SqlExecutor): Promise<void> {
  const unresolved = await scanForUnresolvedExecutionState(client);
  if (unresolved.length > 0) throw new RecoveryModeError(unresolved);
}

/**
 * The single combined pre-mutation gate every interface choke point calls (decision 7 + the
 * tightened decision on recovery mode): an in-progress export/import/migration blocks first,
 * then recovery mode. Reused by src/proxy.ts, the CLI's `runCliCommand`, and MCP's
 * `createMcpToolHandlers` -- one implementation, not three (AGENTS.md §D).
 */
export async function assertDeviceAvailableForMutation(client: SqlExecutor): Promise<void> {
  const { getOperationLock } = await import("@/lib/operation-lock");
  const lock = await getOperationLock(client);
  if (lock) {
    throw new OperationLockError({ heldBy: lock, stale: false });
  }
  await assertNotInRecoveryMode(client);
}

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
}): Promise<ExportHandoffResult> {
  return withOperationLock(params.client, "export", async () => {
    const unresolvedAtExportTime = await scanForUnresolvedExecutionState(params.client);
    const manifest = await exportSnapshot({
      client: params.client,
      snapshotsDir: params.snapshotsDir,
      deviceId: params.deviceId,
      schemaVersion: params.schemaVersion,
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
}): Promise<ImportHandoffResult> {
  return withOperationLock(params.liveClient, "import", async () => {
    const localLineage = await readLineageState(params.liveClient);
    const { manifest, isDuplicateOfCurrent } = await verifySnapshotForImport({
      snapshotDir: params.snapshotDir,
      localLineage,
    });

    if (isDuplicateOfCurrent) {
      return { status: "duplicate_noop", manifest };
    }

    // Backup-before-migrate (decision 1's mechanism, reused): the live DB is never mutated
    // below without a fresh, verified recovery point already on disk.
    const backupPath = path.join(
      params.migrationBackupsDir,
      `pre-import-${Date.now()}-${randomUUID().slice(0, 8)}.db`
    );
    await copyDatabaseConsistently(params.liveClient, backupPath);

    // Never migrate the live DB's schema via the snapshot -- bring a private working copy of
    // the snapshot's own data.db up to this build's version instead (reuses
    // initializeDatabaseSchema unchanged, including its own reject-newer guarantee).
    const workingCopyPath = path.join(params.workingDir, `import-${randomUUID()}.db`);
    const snapshotDbClient = createClient({
      url: `file:${path.join(params.snapshotDir, "data.db")}`,
    });
    try {
      await copyDatabaseConsistently(snapshotDbClient, workingCopyPath);
    } finally {
      snapshotDbClient.close();
    }
    await migrateStagedCopy(workingCopyPath);

    const unresolved = await scanFileForUnresolvedExecutionState(workingCopyPath);

    // applySnapshotToDatabase owns its own transaction (ATTACH cannot happen inside an
    // already-open one -- see that function's own comment). The two writes below are each a
    // single, already-atomic statement; a crash between the merge commit and these would at
    // worst leave the lineage pointer one step stale, which the next export/import attempt
    // can recover from -- it does not affect the data merge's own correctness.
    await applySnapshotToDatabase(params.liveClient, workingCopyPath);
    await writeLineageState(params.liveClient, {
      lastSnapshotId: manifest.snapshotId,
      lastGeneration: manifest.generation,
    });
    await recordHandoffLog(params.liveClient, {
      direction: "import",
      snapshotId: manifest.snapshotId,
      detail: { unresolvedCount: unresolved.length },
    });

    if (unresolved.length > 0) {
      return { status: "activated_recovery_mode", manifest, unresolved };
    }
    return { status: "activated_normal", manifest };
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
