// Moved to the standalone gate module (architecture audit M5); re-exported unchanged.
export { scanForUnresolvedExecutionState, UNRESOLVED_EXECUTION_STATUSES, type UnresolvedExecutionRow };
import {
  scanForUnresolvedExecutionState,
  UNRESOLVED_EXECUTION_STATUSES,
  type UnresolvedExecutionRow,
} from "@/lib/device-mutation-gate";
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
  LINEAGE_FILE_NAME,
  listPublishedSnapshotIds,
  MAX_ANCESTORS,
  publishSnapshot,
  readLineageFile,
  readManifestFromDir,
  writeLineageFile,
  writeManifest,
} from "./adapters/filesystem";
import {
  computeContentFingerprint,
  computeFileContentFingerprint,
  transferredTablesAreEmpty,
} from "./adapters/fingerprint";
import { readLineageState, writeLineageState, type LineageState } from "./adapters/lineage-store";

/** Execution-ledger statuses where a real YouTube write may have been sent but the outcome is
 * not yet certain -- the only ones a device-handoff import must never silently resolve
 * (`PENDING`/`AWAITING_EXECUTION` are always safe: no write was ever attempted for them). */

/** Newest-first, de-duplicated, capped ancestry list. */
function mergeAncestors(...lists: Array<Array<string | null>>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const id of list) {
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out.slice(0, MAX_ANCESTORS);
}

export async function exportSnapshot(params: {
  client: SqlExecutor;
  snapshotsDir: string;
  deviceId: string;
  schemaVersion: number;
  /**
   * "Keep this computer's data" (DEVICE_AUTO_SYNC_PLAN.md §3.6): publish the local state as the
   * CHILD of another device's snapshot, so that device fast-forwards to it. The local lineage's own
   * history stays in the ancestry too.
   */
  supersede?: { snapshotId: string; generation: number; ancestors: string[] };
  /** Snapshots this one deliberately replaces by a human decision (see `SnapshotLineageFile`). */
  supersedes?: string[];
  /** `false`: never create `snapshotsDir` itself (automatic device sync). Default `true`. */
  createSnapshotsDir?: boolean;
}): Promise<SnapshotManifest> {
  const lineage = await readLineageState(params.client);
  const snapshotId = randomUUID();
  const parentSnapshotId = params.supersede ? params.supersede.snapshotId : lineage.lastSnapshotId;
  const generation = Math.max(lineage.lastGeneration, params.supersede?.generation ?? 0) + 1;
  const ancestors = params.supersede
    ? mergeAncestors([params.supersede.snapshotId], params.supersede.ancestors, [lineage.lastSnapshotId], lineage.ancestors ?? [])
    : mergeAncestors([lineage.lastSnapshotId], lineage.ancestors ?? []);

  const { dir: stagingDir } = await createStagingDir(params.snapshotsDir, params.createSnapshotsDir ?? true);
  let published: SnapshotManifest;
  let contentFingerprint: string;
  try {
    const dbDestPath = path.join(stagingDir, "data.db");
    await copyDatabaseConsistently(params.client, dbDestPath);
    await scrubDatabaseCopy(params.client, dbDestPath);
    // The fingerprint of the EXPORTED FILE, not of the live DB after the copy: a change that raced
    // the copy is not in this snapshot, so it must still read as unpublished (AC-AS-05).
    contentFingerprint = await computeFileContentFingerprint(params.client, dbDestPath);
    const { sha256, sizeBytes } = await sha256File(dbDestPath);
    await writeLineageFile(stagingDir, { ancestors, supersedes: params.supersedes ?? [] });
    const lineageFile = await sha256File(path.join(stagingDir, LINEAGE_FILE_NAME));

    const manifest: SnapshotManifest = {
      formatVersion: 1,
      snapshotId,
      parentSnapshotId,
      sourceDeviceId: params.deviceId,
      generation,
      schemaVersion: params.schemaVersion,
      createdAt: new Date().toISOString(),
      files: [
        { path: "data.db", sha256, sizeBytes },
        { path: LINEAGE_FILE_NAME, sha256: lineageFile.sha256, sizeBytes: lineageFile.sizeBytes },
      ],
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

  await writeLineageState(params.client, {
    lastSnapshotId: snapshotId,
    lastGeneration: generation,
    contentFingerprint,
    ancestors,
  });
  return published;
}

/**
 * DEVICE_AUTO_SYNC_PLAN.md §3.1: `manifest` continues the local lineage without discarding
 * anything the local head contains -- its parent IS the local head, the local head is among its
 * recorded ancestors, or this device has no lineage yet.
 */
export function isFastForwardOf(
  manifest: Pick<SnapshotManifest, "parentSnapshotId">,
  ancestors: string[] | null,
  local: Pick<LineageState, "lastSnapshotId">
): boolean {
  if (local.lastSnapshotId === null) return true;
  if (manifest.parentSnapshotId === local.lastSnapshotId) return true;
  return (ancestors ?? []).includes(local.lastSnapshotId);
}

/**
 * DEVICE_AUTO_SYNC_PLAN.md §2: whether this device has changes to its transferred tables that are
 * not in its lineage head. Fails toward "dirty": an unknown fingerprint (a lineage from before
 * v36) is dirty; with no lineage at all, only completely empty transferred tables are clean.
 */
export async function hasUnpublishedLocalChanges(
  client: SqlExecutor,
  /** The current content fingerprint, when the caller already computed it (saves a full scan). */
  currentFingerprint?: string
): Promise<boolean> {
  const lineage = await readLineageState(client);
  if (lineage.lastSnapshotId === null) return !(await transferredTablesAreEmpty(client));
  if (!lineage.contentFingerprint) return true;
  return (currentFingerprint ?? (await computeContentFingerprint(client))) !== lineage.contentFingerprint;
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
  /**
   * "Take the other computer's data" (DEVICE_AUTO_SYNC_PLAN.md §3.6) -- an explicit human choice
   * to discard this device's divergent history. Skips ONLY the lineage check; completeness and
   * checksums are still verified.
   */
  acceptDivergentLineage?: boolean;
}): Promise<{
  manifest: SnapshotManifest;
  isDuplicateOfCurrent: boolean;
  ancestors: string[] | null;
  supersedes: string[];
}> {
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
  const lineageFile = await readLineageFile(params.snapshotDir, manifest);
  const ancestors = lineageFile?.ancestors ?? null;
  const isDuplicateOfCurrent = manifest.snapshotId === local.lastSnapshotId;
  // Direct child, a descendant several generations on (its recorded ancestry contains the local
  // head, §3.1), or this device's very first import.
  const continuesLocalLineage = isFastForwardOf(manifest, ancestors, local);

  if (!isDuplicateOfCurrent && !continuesLocalLineage && !params.acceptDivergentLineage) {
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

  return { manifest, isDuplicateOfCurrent, ancestors, supersedes: lineageFile?.supersedes ?? [] };
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
    // initializeDatabaseSchema leaves the connection in WAL mode (its own PRAGMA). A later
    // ATTACH of this same file from a *different* connection (applySnapshotToDatabase, still
    // inside the live DB's transaction) was observed to fail with "database staged is locked"
    // on Windows -- a WAL-mode file's -wal/-shm sidecars are not reliably released the instant
    // this client closes. Switching back to a single-file journal mode forces a full
    // checkpoint and removes those sidecars before anything else ever opens this file again.
    await client.execute("PRAGMA journal_mode = DELETE");
  } finally {
    client.close();
  }
}

/** Convenience wrapper for a standalone database file (staged copies) -- opens and closes its
 * own connection around scanForUnresolvedExecutionState. */
export async function scanFileForUnresolvedExecutionState(
  dbPath: string
): Promise<UnresolvedExecutionRow[]> {
  const client = createClient({ url: `file:${dbPath}` });
  try {
    return await scanForUnresolvedExecutionState(client);
  } finally {
    client.close();
  }
}

/**
 * The per-table merge (decision 2a): every SNAPSHOT_REPLACE_ON_IMPORT_TABLES table is
 * replaced wholesale from the (already migrated, verified) staged copy. `ai_connections` no
 * longer needs its own upsert-by-id special case here (M6, 2026-09-23) -- it isn't transferred
 * by this mechanism at all any more, `src/lib/sync-gateway/ai-connections-catalog/` owns it
 * continuously instead. `users`, `ai_connection_credentials`, `video_execution_locks`,
 * `app_operation_locks`, and this device's own
 * `handoff_log`/`recovery_acknowledgements`/`schema_meta`/`snapshot_lineage` are never
 * referenced here at all -- there is structurally no code path in this function that can touch
 * them.
 */
// RISK-29 (docs/TECHNICAL_DEBT.md): `PRAGMA table_info` reports columns in physical storage
// order (`cid`) -- the same order `SELECT *` would return them in. Two devices whose table was
// created differently (fresh from the current baseline `CREATE TABLE`, vs. upgraded via a later
// `ALTER TABLE ... ADD COLUMN`, which SQLite always appends at the end) can have genuinely
// different physical column orders for the identical logical schema. Reading this from the
// *live* table (the merge target) and using it explicitly for both sides of the INSERT below
// makes the merge robust to that -- it no longer matters what physical order the staged copy's
// columns happen to be in.
async function getColumnNames(client: SqlExecutor, table: string): Promise<string[]> {
  const result = (await client.execute(`PRAGMA table_info("${table}")`)) as {
    rows: Array<{ name: string }>;
  };
  return result.rows.map((row) => row.name);
}

export async function applySnapshotToDatabase(
  liveClient: SqlExecutor,
  stagedDbPath: string,
  /**
   * Automatic device sync, review round 2: steps that must run INSIDE the merge transaction, so no
   * other connection's write can land between them and the merge (`BEGIN IMMEDIATE` holds the
   * write lock until COMMIT). `beforeMerge` runs before the first DELETE and may throw to roll back
   * with nothing changed; `afterMerge` runs after the last INSERT, before COMMIT. Neither may ATTACH.
   */
  hooks: { beforeMerge?: () => Promise<void>; afterMerge?: () => Promise<void> } = {}
): Promise<void> {
  // ATTACH must happen *before* any transaction is opened on this connection -- attaching a
  // new database file after `BEGIN` was found to fail with "database staged is locked"
  // (verified directly against this exact @libsql/client build, reproduced in isolation).
  // Attaching first, then BEGIN/COMMIT around the writes, then DETACH after COMMIT, does not
  // have that problem -- so this function owns its own transaction boundary; a caller must not
  // wrap another BEGIN around a call to this function.
  await liveClient.execute({ sql: "ATTACH DATABASE ? AS staged", args: [stagedDbPath] });
  try {
    // RISK-33 (docs/TECHNICAL_DEBT.md): `PRAGMA foreign_keys` is a no-op once a transaction is
    // open, so it must be toggled here, before BEGIN -- verified directly against this
    // @libsql/client build, which (unlike stock better-sqlite3) defaults foreign_keys=ON for
    // every new connection. Without this, `DELETE FROM "channels"` below fails immediately with
    // SQLITE_CONSTRAINT the moment the receiving device already has any videos/change_sets/
    // batches/etc. referencing an existing channel row -- i.e. on essentially every real-world
    // import into a device that has previously synced data, reproduced directly in isolation.
    // Restored to ON in the `finally` below so this shared connection never runs any later,
    // unrelated statement with FK enforcement silently disabled.
    await liveClient.execute("PRAGMA foreign_keys = OFF");
    try {
      await liveClient.execute("BEGIN IMMEDIATE");
      try {
        if (hooks.beforeMerge) await hooks.beforeMerge();
        // Review of the architecture-audit fixes (2026-10-01): a snapshot exported by an OLDER build
        // may lack a table that is transferred today (e.g. `video_edit_audit_events`, allowlisted
        // only from 2026-10-01 on; its scrub dropped it). Such a table is left exactly as it is on
        // the receiving device -- never wiped, and never allowed to fail the whole import.
        const stagedTablesResult = (await liveClient.execute(
          "SELECT name FROM staged.sqlite_master WHERE type = 'table'"
        )) as { rows: Array<Record<string, unknown>> };
        const stagedTables = new Set(stagedTablesResult.rows.map((row) => String(row.name)));
        for (const table of SNAPSHOT_REPLACE_ON_IMPORT_TABLES) {
          if (!stagedTables.has(table)) continue;
          const columns = await getColumnNames(liveClient, table);
          const columnList = columns.map((c) => `"${c}"`).join(", ");
          await liveClient.execute(`DELETE FROM "${table}"`);
          await liveClient.execute(
            `INSERT INTO "${table}" (${columnList}) SELECT ${columnList} FROM staged."${table}"`
          );
        }

        if (hooks.afterMerge) await hooks.afterMerge();
        await liveClient.execute("COMMIT");
      } catch (error) {
        await liveClient.execute("ROLLBACK");
        throw error;
      }
    } finally {
      await liveClient.execute("PRAGMA foreign_keys = ON");
    }
  } finally {
    await liveClient.execute("DETACH DATABASE staged");
  }
}

export async function listSnapshots(snapshotsDir: string): Promise<string[]> {
  return listPublishedSnapshotIds(snapshotsDir);
}

export { readLineageState, writeLineageState, type LineageState };
