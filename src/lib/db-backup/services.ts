import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const PRE_MIGRATION_PREFIX = "pre-migration";
/**
 * When the last schema migration succeeded (milliseconds, as text), written in `backups/migrations/` by
 * {@link recordSuccessfulMigration}. Migrations are not transactional: a failing one is retried (every few seconds, and by
 * every restart), and each attempt takes a new pre-migration copy -- of a database the failed attempts may already have
 * changed. The OLDEST copy taken since the last success is the clean one from before the upgrade, the one way back to the
 * previous build: retention never deletes it.
 */
export const MIGRATION_SUCCESS_MARKER = ".last-successful-migration";

const BACKUP_NAME = (prefix: string) => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)-[0-9A-Za-z]+\\.db$`);

async function readSuccessMarker(dir: string): Promise<number> {
  try {
    const value = Number((await readFile(path.join(dir, MIGRATION_SUCCESS_MARKER), "utf8")).trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Deletes the older automatic backups in `dir`, keeping the newest `keep` of each prefix -- newest by the millisecond
 * timestamp in the name (`<prefix>-<ms>-<suffix>.db`, the form every writer uses). Never deleted: `protect` (the backup
 * just written), and the oldest `pre-migration` copy taken since the last successful migration (see
 * {@link MIGRATION_SUCCESS_MARKER}). Returns the names deleted.
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
    const pattern = BACKUP_NAME(prefix);
    const ours = names
      .map((name) => ({ name, at: Number(pattern.exec(name)?.[1] ?? NaN) }))
      .filter((entry) => Number.isFinite(entry.at))
      .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
    const kept = new Set<string>();
    if (prefix === PRE_MIGRATION_PREFIX) {
      const lastSuccess = await readSuccessMarker(dir);
      const sinceSuccess = ours.filter((entry) => entry.at > lastSuccess);
      const preUpgrade = sinceSuccess[sinceSuccess.length - 1];
      if (preUpgrade) kept.add(preUpgrade.name);
    }
    for (const entry of ours.slice(keep)) {
      const full = path.join(dir, entry.name);
      if (kept.has(entry.name) || protectedPaths.has(path.resolve(full))) continue;
      await rm(full, { force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}

/**
 * After the schema migrations SUCCEEDED (only then): trims the pre-migration copies to the newest 10 -- the one just
 * written and the clean pre-upgrade copy always stay -- and records the success, so the next upgrade's own first copy
 * becomes the protected one. Never called while a migration fails: every retry's copy stays until one attempt succeeds.
 */
export async function recordSuccessfulMigration(dir: string, input: { at: number; justWritten?: string | null }): Promise<string[]> {
  const removed = await pruneMigrationBackups(dir, { prefixes: [PRE_MIGRATION_PREFIX], protect: input.justWritten ? [input.justWritten] : [] });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, MIGRATION_SUCCESS_MARKER), String(input.at), "utf8");
  return removed;
}
