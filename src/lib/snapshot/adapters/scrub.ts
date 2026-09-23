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
    // RISK-33 (docs/TECHNICAL_DEBT.md): with FK enforcement on (this @libsql/client build
    // defaults `foreign_keys=ON`), `DROP TABLE` performs an implicit delete of every row first --
    // originally found because a device with at least one `rules` row (`rules.user_id`
    // referencing the `users` table also being dropped) could fail here. `rules` itself is now
    // one of the tables this loop drops (removed from the transfer allowlist 2026-09-22 -- the
    // feature no longer exists), but the general hazard the fix addresses is unchanged: any
    // not-yet-dropped allowlisted/non-allowlisted table with a FK into an already-dropped one
    // would hit the same failure. Disabling enforcement for this same-connection scrub is safe:
    // `scrub_target` is a throwaway copy about to be published (or discarded on error) and is
    // never queried again after this function returns.
    await client.execute("PRAGMA foreign_keys = OFF");
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
      await client.execute("PRAGMA foreign_keys = ON");
    }
  } finally {
    await client.execute("DETACH DATABASE scrub_target");
  }
}
