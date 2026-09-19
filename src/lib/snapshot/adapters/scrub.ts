import type { SqlExecutor } from "../contracts";
import { SNAPSHOT_TRANSFERRED_TABLES } from "../contracts";

const ALLOWLIST = new Set<string>(SNAPSHOT_TRANSFERRED_TABLES);

type ExecuteResult = { rows: Array<Record<string, unknown>> };

/**
 * Scrubs the freshly copied `data.db` file via `ATTACH DATABASE` from the caller's *already
 * open* connection, instead of opening a second, separate client on the staged file and
 * closing it again -- opening-then-closing a second SQLite connection to the same file in
 * quick succession is exactly what produced a real, reproducible Windows EBUSY race against
 * the subsequent staging-directory rename (a closed native-binding file handle is not always
 * released by the OS before the next filesystem call). Attach/detach on one already-live
 * connection has no such lifecycle to race.
 *
 * Drops every table not on the explicit transfer allowlist (INV-CP.1: no snapshot ever
 * contains `users`/`ai_connection_credentials`/etc.), then `VACUUM`s the attached database so
 * the dropped tables' data pages are actually reclaimed/overwritten, not merely unreferenced.
 */
export async function scrubDatabaseCopy(client: SqlExecutor, dbPath: string): Promise<void> {
  await client.execute({ sql: "ATTACH DATABASE ? AS scrub_target", args: [dbPath] });
  try {
    const tables = (await client.execute(
      "SELECT name FROM scrub_target.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )) as ExecuteResult;

    for (const row of tables.rows) {
      const name = String(row.name);
      if (!ALLOWLIST.has(name)) {
        await client.execute(`DROP TABLE IF EXISTS scrub_target."${name}"`);
      }
    }

    await client.execute("VACUUM scrub_target");
  } finally {
    await client.execute("DETACH DATABASE scrub_target");
  }
}
