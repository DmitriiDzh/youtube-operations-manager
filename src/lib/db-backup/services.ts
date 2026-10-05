import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseBackupError, type SqlExecutor } from "./contracts";

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only for "this specific table doesn't exist yet" (a database that hasn't run the
 * migration creating it). Any other failure (contention, I/O, corruption) must propagate, not
 * be silently treated as "nothing there yet" -- a transient error masquerading as a missing
 * table would fail *open* exactly where a caller relies on this to fail closed. Single shared
 * implementation (RISK-19/21, docs/TECHNICAL_DEBT.md) -- previously duplicated verbatim in
 * `src/lib/operation-lock/services.ts` and `src/lib/snapshot/adapters/lineage-store.ts`
 * (AGENTS.md §D, one guardrail per concern).
 */
export function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table/i.test(message);
}

/**
 * Produces a single-file, internally consistent copy of a live SQLite/libSQL database using
 * `VACUUM INTO` -- this reads a transactionally-consistent snapshot of committed data as of
 * the moment it runs, regardless of WAL/SHM sidecar files, and never touches the live
 * connection's own file (docs/DEVELOPMENT_PLAYBOOK.md §6.11's "never file-copy a live WAL-mode
 * database" applies to a raw fs.copyFile, not to this).
 *
 * Shared by schema-migration backups (src/lib/db.ts) and the snapshot export pipeline
 * (src/lib/snapshot/) -- one implementation, per AGENTS.md §D, not two.
 *
 * Never overwrites an existing file at `destPath` -- `VACUUM INTO` itself refuses to write to
 * a path that already exists, which is exactly the "never overwrite the only valid backup"
 * guarantee this needs.
 */
export async function copyDatabaseConsistently(
  client: SqlExecutor,
  destPath: string
): Promise<{ path: string }> {
  if (await pathExists(destPath)) {
    throw new DatabaseBackupError(
      "backup_destination_exists",
      `Refusing to overwrite an existing file at ${destPath}`
    );
  }

  await mkdir(path.dirname(destPath), { recursive: true });

  await client.execute({ sql: "VACUUM INTO ?", args: [destPath] });

  return { path: destPath };
}
