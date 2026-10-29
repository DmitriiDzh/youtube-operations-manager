import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
const BACKUP_NAME = (prefix: string) => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)-[0-9A-Za-z]+\\.db$`);

/**
 * The pre-migration copies' bookkeeping in `backups/migrations/` (JSON). Migrations are not transactional: a failing one is
 * retried (every few seconds, and at every restart) and each attempt takes a new copy -- of a database the failed attempts
 * may already have changed. So the FIRST copy of an upgrade (`pendingUpgradeCopy`, recorded by NAME once it is complete,
 * never by clock order, with the versions it migrates from and to) is the clean one, the one way back to the previous build: no prune deletes it while the upgrade has
 * not succeeded. Every successful start writes the file again (`lastSuccessAt`, `pendingUpgradeCopy: null`), so a missing or
 * stale file heals on the next start; `lastProtectedCopy` names the upgrade's first copy of the last success.
 */
export const MIGRATION_SUCCESS_MARKER = ".last-successful-migration";

export type MigrationBackupState = {
  pendingUpgradeCopy: string | null;
  /** The schema versions that upgrade migrates from and to (null in a record written before they were kept). */
  pendingFromVersion: number | null;
  pendingToVersion: number | null;
  lastSuccessAt: number | null;
  lastProtectedCopy: string | null;
};

export async function readMigrationBackupState(dir: string): Promise<MigrationBackupState> {
  const empty: MigrationBackupState = { pendingUpgradeCopy: null, pendingFromVersion: null, pendingToVersion: null, lastSuccessAt: null, lastProtectedCopy: null };
  const version = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : null);
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(dir, MIGRATION_SUCCESS_MARKER), "utf8"));
    if (!parsed || typeof parsed !== "object") return empty;
    const raw = parsed as Record<string, unknown>;
    const name = (value: unknown) => (typeof value === "string" && BACKUP_NAME(PRE_MIGRATION_PREFIX).test(value) ? value : null);
    return {
      pendingUpgradeCopy: name(raw.pendingUpgradeCopy),
      pendingFromVersion: version(raw.pendingFromVersion),
      pendingToVersion: version(raw.pendingToVersion),
      lastSuccessAt: typeof raw.lastSuccessAt === "number" && Number.isFinite(raw.lastSuccessAt) ? raw.lastSuccessAt : null,
      lastProtectedCopy: name(raw.lastProtectedCopy),
    };
  } catch {
    return empty;
  }
}

async function writeMigrationBackupState(dir: string, state: MigrationBackupState): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, MIGRATION_SUCCESS_MARKER);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), "utf8");
  await rename(temporary, target);
}

/**
 * Deletes the older automatic backups in `dir`, keeping the newest `keep` of each prefix -- newest by the millisecond
 * timestamp in the name (`<prefix>-<ms>-<suffix>.db`, the form every writer uses). Never deleted: `protect` (the backup
 * just written), and the first copy of an upgrade that has not succeeded yet ({@link MIGRATION_SUCCESS_MARKER}). Returns
 * the names deleted.
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
      const { pendingUpgradeCopy } = await readMigrationBackupState(dir);
      if (pendingUpgradeCopy) kept.add(pendingUpgradeCopy);
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
 * A start's pre-migration backups, in the order the boot must follow (`db.ts` and its tests use exactly this):
 * `takeCopy({ fromVersion, toVersion })` inside `beforeMigrations` copies first and records the copy as the upgrade's first
 * one only once the copy is complete (a crash mid-copy never leaves a truncated file protected); it never prunes. Then
 * `succeeded()` only once the migrations went through: when a copy was taken, prune to the newest 10 protecting this start's
 * copy AND the upgrade's first copy, and only then write the state (success, no pending upgrade). Written on every successful
 * start that finds it missing or stale, so it heals.
 *
 * A recorded first copy stays the upgrade's first copy while the database has not reached that upgrade's target version
 * (retries after partly applied migrations start from a higher version, but still below the target; so does a fixed build
 * for the same failed upgrade). It is replaced when its file is gone, or when this start upgrades from at or above the
 * recorded target: that upgrade finished, only its success was never recorded (a crash between the migrations and
 * `succeeded()`), and this is a new upgrade.
 */
export function createMigrationBackups(deps: { dir: string; copy(destPath: string): Promise<void>; now(): number; suffix(): string }) {
  let written: string | null = null;
  return {
    async takeCopy(versions: { fromVersion: number; toVersion: number }): Promise<string> {
      const name = `${PRE_MIGRATION_PREFIX}-${deps.now()}-${deps.suffix()}.db`;
      const destPath = path.join(deps.dir, name);
      await deps.copy(destPath);
      written = destPath;
      const state = await readMigrationBackupState(deps.dir);
      const pendingExists = state.pendingUpgradeCopy !== null && (await pathExists(path.join(deps.dir, state.pendingUpgradeCopy)));
      const pendingFinished = state.pendingToVersion !== null && versions.fromVersion >= state.pendingToVersion;
      if (!pendingExists || pendingFinished) {
        await writeMigrationBackupState(deps.dir, { ...state, pendingUpgradeCopy: name, pendingFromVersion: versions.fromVersion, pendingToVersion: versions.toVersion });
      }
      return destPath;
    },

    async succeeded(): Promise<string[]> {
      const state = await readMigrationBackupState(deps.dir);
      let removed: string[] = [];
      if (written) {
        const protect = [written, ...(state.pendingUpgradeCopy ? [path.join(deps.dir, state.pendingUpgradeCopy)] : [])];
        removed = await pruneMigrationBackups(deps.dir, { prefixes: [PRE_MIGRATION_PREFIX], protect });
      }
      // Nothing migrated and the record already says "succeeded, nothing pending": no write on every start.
      if (!written && state.pendingUpgradeCopy === null && state.lastSuccessAt !== null) return removed;
      await writeMigrationBackupState(deps.dir, {
        pendingUpgradeCopy: null,
        pendingFromVersion: null,
        pendingToVersion: null,
        lastSuccessAt: deps.now(),
        lastProtectedCopy: written ? (state.pendingUpgradeCopy ?? path.basename(written)) : state.lastProtectedCopy,
      });
      return removed;
    },
  };
}
