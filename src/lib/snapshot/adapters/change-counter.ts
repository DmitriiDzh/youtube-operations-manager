import type { SqlExecutor } from "../contracts";
import { SNAPSHOT_REPLACE_ON_IMPORT_TABLES } from "../contracts";
import { computeContentFingerprint } from "./fingerprint";

type ExecuteResult = { rows: Array<Record<string, unknown>> };

/**
 * BL-270 (owner TG 4662/4665): a cheap "did the transferred data move?" signal, so automatic device sync no longer reads and hashes
 * every transferred table (~22 MB) every 30 s. Each transferred table gets three triggers (insert / update / delete) that bump its
 * row in `transferred_change_counters` (device-local). They are schema objects, so a write from ANY connection or process (the web
 * server, MCP, the CLI) counts.
 *
 * The counter table and the triggers are created here at run time, never by a migration (review of BL-270): no schema version is
 * spent on them, so the two computers need not update together; a migration that rebuilds a table drops that table's triggers, and
 * only a check at run time can put them back. The table is device-local and never transferred (the scrub drops it and the triggers
 * from every snapshot copy), so an imported or staged database simply has neither until this device's sync creates them. Whatever the counters say, the full content fingerprint stays the truth; the counters only
 * decide when it must be computed again (see `createCachedContentFingerprint`).
 */
export const TRANSFERRED_CHANGE_COUNTER_TABLE = "transferred_change_counters";
export const TRANSFERRED_CHANGE_TRIGGER_PREFIX = "ytom_transferred_change_";
const OPERATIONS = ["insert", "update", "delete"] as const;

export function transferredChangeTriggerName(table: string, operation: (typeof OPERATIONS)[number]): string {
  return `${TRANSFERRED_CHANGE_TRIGGER_PREFIX}${table}_${operation}`;
}

const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function existingTables(client: SqlExecutor, names: readonly string[]): Promise<Set<string>> {
  const result = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")) as ExecuteResult;
  const all = new Set(result.rows.map((row) => String(row.name)));
  return new Set(names.filter((name) => all.has(name)));
}

/**
 * Makes sure the counter table exists and every existing transferred table has its three triggers and a counter row. Returns
 * `"ready"` when they were all there already, and `"installed"` when something had to be (re)created -- the table itself included --
 * a write may have gone uncounted before that, so the caller must not trust an older cached fingerprint.
 */
export async function ensureTransferredChangeTriggers(client: SqlExecutor): Promise<"ready" | "installed"> {
  const tables = await existingTables(client, [...SNAPSHOT_REPLACE_ON_IMPORT_TABLES, TRANSFERRED_CHANGE_COUNTER_TABLE]);
  let installed = false;
  if (!tables.has(TRANSFERRED_CHANGE_COUNTER_TABLE)) {
    // Spelled out (not through the constant): the schema-classification tests find every table by this literal statement.
    await client.execute(
      "CREATE TABLE IF NOT EXISTS transferred_change_counters (table_name TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL DEFAULT 0)"
    );
    installed = true;
  }
  tables.delete(TRANSFERRED_CHANGE_COUNTER_TABLE);
  const triggers = (await client.execute(
    `SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '${TRANSFERRED_CHANGE_TRIGGER_PREFIX}%'`
  )) as ExecuteResult;
  const present = new Set(triggers.rows.map((row) => `${String(row.tbl_name)}\u0000${String(row.name)}`));
  const counters = (await client.execute(`SELECT table_name FROM "${TRANSFERRED_CHANGE_COUNTER_TABLE}"`)) as ExecuteResult;
  const counted = new Set(counters.rows.map((row) => String(row.table_name)));
  for (const table of tables) {
    if (!counted.has(table)) {
      await client.execute({ sql: `INSERT OR IGNORE INTO "${TRANSFERRED_CHANGE_COUNTER_TABLE}" (table_name, version) VALUES (?, 0)`, args: [table] });
    }
    for (const operation of OPERATIONS) {
      const name = transferredChangeTriggerName(table, operation);
      if (present.has(`${table}\u0000${name}`)) continue;
      // A trigger of that name on another table (cannot happen through this code) is replaced, never left pointing elsewhere.
      await client.execute(`DROP TRIGGER IF EXISTS "${name}"`);
      await client.execute(
        `CREATE TRIGGER "${name}" AFTER ${operation.toUpperCase()} ON "${table}" BEGIN ` +
          `UPDATE "${TRANSFERRED_CHANGE_COUNTER_TABLE}" SET version = version + 1 WHERE table_name = ${quoteLiteral(table)}; END`
      );
      installed = true;
    }
  }
  return installed ? "installed" : "ready";
}

/**
 * BL-270 review (finding 5): a whole-table replace (the snapshot import's DELETE + INSERT ... SELECT) with the triggers in place loses
 * SQLite's truncate optimisation and bumps a counter per row (measured on a real 22 MB snapshot: ~160 ms -> ~300 ms). The import drops
 * this device's change triggers inside its own transaction and puts them back before COMMIT (`restoreTransferredChangeTriggers`), so
 * a rollback restores them too. Returns whether any were there (only then are they put back).
 */
export async function dropTransferredChangeTriggers(client: SqlExecutor): Promise<boolean> {
  const triggers = (await client.execute(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '${TRANSFERRED_CHANGE_TRIGGER_PREFIX}%'`
  )) as ExecuteResult;
  for (const row of triggers.rows) await client.execute(`DROP TRIGGER IF EXISTS "${String(row.name)}"`);
  return triggers.rows.length > 0;
}

/**
 * Puts the triggers back after `dropTransferredChangeTriggers` and bumps every counter once, so every cached fingerprint -- in this
 * process or another -- is recomputed at its next read (the schema cookie moved with the DROP/CREATE too).
 */
export async function restoreTransferredChangeTriggers(client: SqlExecutor): Promise<void> {
  await ensureTransferredChangeTriggers(client);
  await client.execute(`UPDATE "${TRANSFERRED_CHANGE_COUNTER_TABLE}" SET version = version + 1`);
}

/**
 * The cheap key: the database's schema cookie (`PRAGMA schema_version` -- any CREATE/DROP/ALTER, a table rebuild included, moves
 * it) and every counter. The same key means no transferred row was written through SQL since it was read and no schema change
 * happened. `null` when there is no counter table.
 */
export async function readTransferredChangeKey(client: SqlExecutor): Promise<string | null> {
  const schema = (await client.execute("PRAGMA schema_version")) as ExecuteResult;
  const cookie = schema.rows[0] ? Object.values(schema.rows[0])[0] : null;
  try {
    const counters = (await client.execute(
      `SELECT table_name, version FROM "${TRANSFERRED_CHANGE_COUNTER_TABLE}" ORDER BY table_name`
    )) as ExecuteResult;
    return `${String(cookie)}|${counters.rows.map((row) => `${String(row.table_name)}=${String(row.version)}`).join(",")}`;
  } catch {
    return null;
  }
}

/** The counters by table (diagnostics: which tables moved between two reads). */
export async function readTransferredChangeCounters(client: SqlExecutor): Promise<Record<string, number>> {
  const result = (await client.execute(`SELECT table_name, version FROM "${TRANSFERRED_CHANGE_COUNTER_TABLE}"`)) as ExecuteResult;
  return Object.fromEntries(result.rows.map((row) => [String(row.table_name), Number(row.version)]));
}

/** At least this often the full fingerprint is computed again even when the key did not move (a write the triggers cannot see). */
export const CONTENT_FINGERPRINT_SAFETY_INTERVAL_MS = 10 * 60_000;

export type CachedContentFingerprint = {
  /** The current content fingerprint -- from the cache while the key has not moved, otherwise computed in full. */
  fingerprint(): Promise<string>;
  /** Forget the cached value (the next call computes in full). */
  invalidate(): void;
};

/**
 * The content fingerprint, recomputed only when needed. A cached value is used only when ALL hold: the triggers were all present
 * at this call and at the call that computed it (nothing re-installed in between), the key (schema cookie + counters) is the same,
 * and it is younger than `safetyIntervalMs`. The key is read BEFORE the full computation, so a write that lands during it moves the
 * key past the cached one and the next call computes again: a change can only ever cause an extra computation, never a missed one.
 */
export function createCachedContentFingerprint(
  client: SqlExecutor,
  options: { now?: () => number; safetyIntervalMs?: number; compute?: (client: SqlExecutor) => Promise<string> } = {}
): CachedContentFingerprint {
  const now = options.now ?? (() => Date.now());
  const safety = options.safetyIntervalMs ?? CONTENT_FINGERPRINT_SAFETY_INTERVAL_MS;
  const compute = options.compute ?? ((c: SqlExecutor) => computeContentFingerprint(c));
  let cached: { key: string; value: string; at: number } | null = null;
  return {
    async fingerprint() {
      let key: string | null = null;
      try {
        const triggers = await ensureTransferredChangeTriggers(client);
        if (triggers === "ready") key = await readTransferredChangeKey(client);
        else if (triggers === "installed") {
          // Some trigger was missing until now: a write may have gone uncounted. Recompute, and key the result from here on.
          cached = null;
          key = await readTransferredChangeKey(client);
        }
      } catch {
        key = null;
      }
      if (key === null) {
        cached = null;
        return compute(client);
      }
      if (cached && cached.key === key && now() - cached.at < safety) return cached.value;
      const value = await compute(client);
      cached = { key, value, at: now() };
      return value;
    },
    invalidate() {
      cached = null;
    },
  };
}
