import path from "node:path";
import { randomUUID } from "node:crypto";
import { copyDatabaseConsistently } from "@/lib/db-backup";
import { initializeDatabaseSchema } from "@/lib/db";
import { createClient } from "@libsql/client";
import {
  SNAPSHOT_REPLACE_ON_IMPORT_TABLES,
  SnapshotError,
  type SnapshotManifest,
  type SqlExecutor,
} from "./contracts";
import { sha256File } from "./adapters/checksum";
import { scrubDatabaseCopy } from "./adapters/scrub";
import {
  createStagingDir,
  discardStagingDir,
  listPublishedSnapshotIds,
  publishSnapshot,
  readManifestFromDir,
  writeManifest,
} from "./adapters/filesystem";
import { readLineageState, writeLineageState, type LineageState } from "./adapters/lineage-store";

/** Execution-ledger statuses where a real YouTube write may have been sent but the outcome is
 * not yet certain -- the only ones a device-handoff import must never silently resolve
 * (`PENDING`/`AWAITING_EXECUTION` are always safe: no write was ever attempted for them). */
export const UNRESOLVED_EXECUTION_STATUSES = ["APPLYING", "UNKNOWN"] as const;

export async function exportSnapshot(params: {
  client: SqlExecutor;
  snapshotsDir: string;
  deviceId: string;
  schemaVersion: number;
}): Promise<SnapshotManifest> {
  const lineage = await readLineageState(params.client);
  const snapshotId = randomUUID();
  const generation = lineage.lastGeneration + 1;

  const { dir: stagingDir } = await createStagingDir(params.snapshotsDir);
  let published: SnapshotManifest;
  try {
    const dbDestPath = path.join(stagingDir, "data.db");
    await copyDatabaseConsistently(params.client, dbDestPath);
    await scrubDatabaseCopy(params.client, dbDestPath);
    const { sha256, sizeBytes } = await sha256File(dbDestPath);

    const manifest: SnapshotManifest = {
      formatVersion: 1,
      snapshotId,
      parentSnapshotId: lineage.lastSnapshotId,
      sourceDeviceId: params.deviceId,
      generation,
      schemaVersion: params.schemaVersion,
      createdAt: new Date().toISOString(),
      files: [{ path: "data.db", sha256, sizeBytes }],
      complete: true,
    };

    // Written last, only once every data file is finalized (AC-SNAP-01) -- and the directory
    // is not visible under its final snapshot id until the rename below.
    await writeManifest(stagingDir, manifest);
    await publishSnapshot(params.snapshotsDir, stagingDir, snapshotId);
    published = manifest;
  } catch (error) {
    await discardStagingDir(stagingDir);
    throw error;
  }

  await writeLineageState(params.client, { lastSnapshotId: snapshotId, lastGeneration: generation });
  return published;
}

async function pathExistsChecked(filePath: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies a published snapshot directory is complete, checksummed correctly, and lineage-
 * compatible with this device's current position -- never applies anything. Divergence is
 * detected structurally (direct-child-of-local, exact-duplicate-of-local, or this device's
 * very first-ever import), never by comparing `createdAt` timestamps (AC-SNAP-06).
 */
export async function verifySnapshotForImport(params: {
  snapshotDir: string;
  localLineage: LineageState;
}): Promise<{ manifest: SnapshotManifest; isDuplicateOfCurrent: boolean }> {
  const manifest = await readManifestFromDir(params.snapshotDir);

  if (!manifest.complete) {
    throw new SnapshotError(
      "snapshot_incomplete",
      `Snapshot ${manifest.snapshotId} is not marked complete -- refusing to import a partial transfer.`
    );
  }

  for (const file of manifest.files) {
    const filePath = path.join(params.snapshotDir, file.path);
    if (!(await pathExistsChecked(filePath))) {
      throw new SnapshotError(
        "snapshot_file_missing",
        `Snapshot ${manifest.snapshotId} is missing referenced file ${file.path}.`,
        { file: file.path }
      );
    }
    const { sha256 } = await sha256File(filePath);
    if (sha256 !== file.sha256) {
      throw new SnapshotError(
        "snapshot_checksum_mismatch",
        `Snapshot ${manifest.snapshotId}'s file ${file.path} failed checksum verification.`,
        { file: file.path, expected: file.sha256, actual: sha256 }
      );
    }
  }

  const local = params.localLineage;
  const isDuplicateOfCurrent = manifest.snapshotId === local.lastSnapshotId;
  const isDirectChild = manifest.parentSnapshotId === local.lastSnapshotId;
  const isFirstEverImport = local.lastSnapshotId === null;

  if (!isDuplicateOfCurrent && !isDirectChild && !isFirstEverImport) {
    throw new SnapshotError(
      "snapshot_divergent_lineage",
      `Snapshot ${manifest.snapshotId} (generation ${manifest.generation}, parent ` +
        `${manifest.parentSnapshotId ?? "none"}) does not continue this device's lineage ` +
        `(currently at ${local.lastSnapshotId ?? "none"}, generation ${local.lastGeneration}). ` +
        "Refusing to guess which side is authoritative.",
      {
        incomingSnapshotId: manifest.snapshotId,
        incomingParentSnapshotId: manifest.parentSnapshotId,
        incomingGeneration: manifest.generation,
        localLastSnapshotId: local.lastSnapshotId,
        localLastGeneration: local.lastGeneration,
      }
    );
  }

  return { manifest, isDuplicateOfCurrent };
}

/**
 * Brings a standalone copy of the snapshot's data.db up to this build's current schema
 * version -- reusing `initializeDatabaseSchema` exactly (no parallel migration
 * implementation, AGENTS.md §D). If the snapshot's own schema_meta reports a version newer
 * than this build supports, this throws the same `SchemaVersionError` a live boot would.
 */
export async function migrateStagedCopy(stagedDbPath: string): Promise<void> {
  const client = createClient({ url: `file:${stagedDbPath}` });
  try {
    await initializeDatabaseSchema(client);
  } finally {
    client.close();
  }
}

/** Read-only: batch_ledger_rows in the staged (already-migrated) copy whose execution status
 * is genuinely uncertain (decision 3 -- never mutated, never resolved, by this module). */
export async function scanForUnresolvedExecutionState(
  stagedDbPath: string
): Promise<Array<{ batchId: string; ledgerRowId: string; videoId: string; status: string }>> {
  const client = createClient({ url: `file:${stagedDbPath}` });
  try {
    const placeholders = UNRESOLVED_EXECUTION_STATUSES.map(() => "?").join(", ");
    const result = await client.execute({
      sql: `SELECT id, batch_id, video_id, status FROM batch_ledger_rows WHERE status IN (${placeholders})`,
      args: [...UNRESOLVED_EXECUTION_STATUSES],
    });
    return result.rows.map((row) => ({
      batchId: String(row.batch_id),
      ledgerRowId: String(row.id),
      videoId: String(row.video_id),
      status: String(row.status),
    }));
  } finally {
    client.close();
  }
}

/**
 * The per-table merge (decision 2a): every SNAPSHOT_REPLACE_ON_IMPORT_TABLES table is
 * replaced wholesale from the (already migrated, verified) staged copy; `ai_connections`
 * upserts by id so a locally stored credential's connection row survives; `users`,
 * `ai_connection_credentials`, `video_execution_locks`, `app_operation_locks`, and this
 * device's own `handoff_log`/`recovery_acknowledgements`/`schema_meta`/`snapshot_lineage` are
 * never referenced here at all -- there is structurally no code path in this function that
 * can touch them.
 */
export async function applySnapshotToDatabase(
  liveClient: SqlExecutor,
  stagedDbPath: string
): Promise<void> {
  await liveClient.execute({ sql: "ATTACH DATABASE ? AS staged", args: [stagedDbPath] });
  try {
    for (const table of SNAPSHOT_REPLACE_ON_IMPORT_TABLES) {
      await liveClient.execute(`DELETE FROM "${table}"`);
      await liveClient.execute(`INSERT INTO "${table}" SELECT * FROM staged."${table}"`);
    }

    const aiConnectionColumns = [
      "id",
      "display_name",
      "adapter_type",
      "base_url",
      "model_id",
      "local_inference_mode",
      "enabled",
      "status",
      "status_message",
      "status_checked_at",
      "capabilities_json",
      "assigned_tasks_json",
      "pricing_json",
      "created_at",
      "updated_at",
    ];
    // `INSERT ... SELECT ... ON CONFLICT DO UPDATE` is not accepted by this SQLite build
    // (verified directly: "near DO: syntax error" for the SELECT form, while the same clause
    // works fine for an INSERT ... VALUES). `INSERT OR REPLACE ... SELECT` is semantically
    // equivalent to the intended upsert here because every column is always included in the
    // SELECT (a full-row replace on a primary-key conflict, keeping the same `id`) -- it is
    // not "replace the row with defaults", it is "replace the row with exactly these values".
    await liveClient.execute(
      `INSERT OR REPLACE INTO ai_connections (${aiConnectionColumns.join(", ")}) ` +
        `SELECT ${aiConnectionColumns.join(", ")} FROM staged.ai_connections`
    );
  } finally {
    await liveClient.execute("DETACH DATABASE staged");
  }
}

export async function listSnapshots(snapshotsDir: string): Promise<string[]> {
  return listPublishedSnapshotIds(snapshotsDir);
}

export { readLineageState, writeLineageState, type LineageState };
