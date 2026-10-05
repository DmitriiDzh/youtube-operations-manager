import { SchemaVersionError, type SchemaMigration, type SqlExecutor } from "./contracts";
import { isMissingTableError } from "@/lib/db-backup";

const SCHEMA_META_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

type ExecuteResult = { rows: Array<Record<string, unknown>> };

async function execute(client: SqlExecutor, query: string | { sql: string; args?: unknown[] }) {
  return (await client.execute(query)) as ExecuteResult;
}

/**
 * Read-only: returns the stamped schema version, or `null` if `schema_meta` doesn't exist yet
 * (a pre-versioning/legacy database) or has no `schema_version` row. Never creates or mutates
 * anything -- this is what lets the reject-newer check run strictly before any schema mutation
 * (docs/decisions/0002-additive-schema-versioning.md, AC-SCHEMA-04).
 */
export async function readSchemaVersion(client: SqlExecutor): Promise<number | null> {
  try {
    const result = await execute(client, "SELECT value FROM schema_meta WHERE key = 'schema_version'");
    if (result.rows.length === 0) return null;
    const raw = result.rows[0].value;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch (error) {
    // RISK-19 (docs/TECHNICAL_DEBT.md): only "schema_meta doesn't exist yet" (a legacy/
    // unversioned database) is a legitimate null. Any other error (SQLITE_BUSY, I/O,
    // corruption) must propagate -- treating it identically to "never initialized" would let
    // assertSupportedSchemaVersion fail *open* on exactly the transient-error window it exists
    // to guard against reaching with an unsupported/incompatible schema.
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

async function writeSchemaVersion(client: SqlExecutor, version: number): Promise<void> {
  await execute(client, SCHEMA_META_TABLE_SQL);
  await execute(client, {
    sql: "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [String(version)],
  });
}

/**
 * Throws `SchemaVersionError` if the database reports a version newer than this build
 * supports. Must be called before any `CREATE`/`ALTER`/`INSERT` statement runs against the
 * database -- callers are responsible for that ordering (see src/lib/db.ts's
 * `initializeDatabaseSchema`, which calls this immediately after the connection-level PRAGMAs
 * and before its baseline schema block).
 */
export async function assertSupportedSchemaVersion(
  client: SqlExecutor,
  supportedVersion: number
): Promise<number | null> {
  const foundVersion = await readSchemaVersion(client);
  if (foundVersion !== null && foundVersion > supportedVersion) {
    throw new SchemaVersionError({ foundVersion, supportedVersion });
  }
  return foundVersion;
}

/**
 * Applies every migration strictly newer than `currentVersion` (or, for a legacy/unversioned
 * database -- `currentVersion === null` -- stamps `baselineVersion` first, since the caller's
 * own baseline `CREATE TABLE IF NOT EXISTS` block has already been run against it by this
 * point). Each migration's own statements are executed and only *then*, on success, is
 * `schema_meta.schema_version` advanced to that migration's version -- a migration that throws
 * partway through leaves the stamped version at the last one that actually completed
 * (AC-SCHEMA-05/06), so a retried boot safely resumes rather than silently skipping it.
 */
export async function runSchemaMigrations(
  client: SqlExecutor,
  options: {
    migrations: SchemaMigration[];
    currentVersion: number | null;
    baselineVersion: number;
  }
): Promise<number> {
  let stamped = options.currentVersion;

  if (stamped === null) {
    await writeSchemaVersion(client, options.baselineVersion);
    stamped = options.baselineVersion;
  }

  const pending = [...options.migrations]
    .filter((migration) => migration.version > (stamped as number))
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    await migration.apply(client);
    await writeSchemaVersion(client, migration.version);
    stamped = migration.version;
  }

  return stamped;
}

export { SchemaVersionError };
export type { SchemaMigration };
