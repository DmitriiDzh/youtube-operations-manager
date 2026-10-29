import { mkdir, readdir, rm, stat } from "node:fs/promises";
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

/**
 * BL-237 (owner, Telegram 2026-10-30, msgs 3864-3866): how many automatic database backups of each kind
 * `backups/migrations/` keeps -- the newest {@link MIGRATION_BACKUPS_KEEP} `pre-migration-*` (taken before a schema
 * migration) and, separately, the newest {@link MIGRATION_BACKUPS_KEEP} `pre-auto-import-*` (taken before an automatic
 * device-sync import). Separate counts, so a day of frequent automatic imports never pushes out the last copy from
 * before a migration. Every other file there (`pre-take-theirs-*`, `pre-superseded-*`, `pre-import-*`,
 * `pre-api-retention-*`, anything else) and every other folder (`backups/manual/`, per-channel backups) is never touched.
 */
export const MIGRATION_BACKUPS_KEEP = 10;
export const RETAINED_BACKUP_PREFIXES = ["pre-migration", "pre-auto-import"] as const;

/**
 * Deletes the older automatic backups in `dir`, keeping the newest `keep` of each prefix -- newest by the millisecond
 * timestamp in the name (`<prefix>-<ms>-<suffix>.db`, the form every writer uses). `protect` (the backup just written) is
 * never deleted, wherever it sorts. Returns the names deleted. Called after a new backup was written successfully.
 */
export async function pruneMigrationBackups(
  dir: string,
  options: { keep?: number; prefixes?: readonly string[]; protect?: readonly string[] } = {}
): Promise<string[]> {
  const keep = options.keep ?? MIGRATION_BACKUPS_KEEP;
  const prefixes = options.prefixes ?? RETAINED_BACKUP_PREFIXES;
  const protectedPaths = new Set((options.protect ?? []).map((p) => path.resolve(p)));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const prefix of prefixes) {
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)-[0-9A-Za-z]+\\.db$`);
    const ours = names
      .map((name) => ({ name, at: Number(pattern.exec(name)?.[1] ?? NaN) }))
      .filter((entry) => Number.isFinite(entry.at))
      .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
    for (const entry of ours.slice(keep)) {
      const full = path.join(dir, entry.name);
      if (protectedPaths.has(path.resolve(full))) continue;
      await rm(full, { force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}
