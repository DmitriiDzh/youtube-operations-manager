import { createClient } from "@libsql/client";
import type { SqlExecutor } from "@/lib/db-backup/contracts";
import { API_DATA_RETENTION_DAYS, nonAuthorizedTables } from "./contracts";

export type PurgeResult = { table: string; deleted: number; blanked: number }[];

type ExecuteResult = { rows: Array<Record<string, unknown>>; rowsAffected?: number };

export type PurgeHooks = {
  /** Runs first inside the purge transaction (e.g. take the content fingerprint before). */
  beforePurge?: () => Promise<void>;
  /** Runs last inside the purge transaction, before COMMIT (e.g. re-baseline the sync fingerprint). */
  afterPurge?: () => Promise<void>;
};

const cutoffFor = (now: Date) => Math.floor(now.getTime() / 1000) - API_DATA_RETENTION_DAYS * 24 * 60 * 60;

async function existingTables(client: SqlExecutor): Promise<Set<string>> {
  const rows = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")) as ExecuteResult;
  return new Set(rows.rows.map((r) => String(r.name)));
}

/** Tables a given database actually has (an old backup may predate some of them). */
async function presentTables(client: SqlExecutor) {
  const present = await existingTables(client);
  return nonAuthorizedTables().filter((t) => present.has(t.table));
}

async function anyExpiring(client: SqlExecutor, cutoffSeconds: number): Promise<boolean> {
  for (const t of await presentTables(client)) {
    const expired = `"${t.clockColumn}" < ?` + (t.apiRowsWhere ? ` AND (${t.apiRowsWhere})` : "");
    const notAlreadyBlank =
      t.keepDecisionWhere && t.alreadyBlankWhere ? ` AND NOT ((${t.keepDecisionWhere}) AND (${t.alreadyBlankWhere}))` : "";
    const found = (await client.execute({
      sql: `SELECT 1 FROM "${t.table}" WHERE ${expired}${notAlreadyBlank} LIMIT 1`,
      args: [cutoffSeconds],
    })) as ExecuteResult;
    if (found.rows.length > 0) return true;
  }
  return false;
}

/** The deletes/blanks themselves, on whatever transaction the caller holds. */
async function applyPurge(client: SqlExecutor, cutoffSeconds: number): Promise<PurgeResult> {
  const result: PurgeResult = [];
  const hasAssignments = (await existingTables(client)).has("channel_record_assignments");
  for (const t of await presentTables(client)) {
    const expired = `"${t.clockColumn}" < ?` + (t.apiRowsWhere ? ` AND (${t.apiRowsWhere})` : "");
    const deletable = t.keepDecisionWhere ? `${expired} AND NOT (${t.keepDecisionWhere})` : expired;
    let blanked = 0;
    if (t.keepDecisionWhere && t.blankSet) {
      const updated = (await client.execute({
        sql:
          `UPDATE "${t.table}" SET ${t.blankSet} WHERE ${expired} AND (${t.keepDecisionWhere})` +
          (t.alreadyBlankWhere ? ` AND NOT (${t.alreadyBlankWhere})` : ""),
        args: [cutoffSeconds],
      })) as ExecuteResult;
      blanked = Number(updated.rowsAffected ?? 0);
    }
    if (t.assignmentRecordKind && hasAssignments) {
      await client.execute({
        sql: `DELETE FROM channel_record_assignments WHERE record_kind = ? AND record_id IN (SELECT id FROM "${t.table}" WHERE ${deletable})`,
        args: [t.assignmentRecordKind, cutoffSeconds],
      });
    }
    const deleted = (await client.execute({ sql: `DELETE FROM "${t.table}" WHERE ${deletable}`, args: [cutoffSeconds] })) as ExecuteResult;
    result.push({ table: t.table, deleted: Number(deleted.rowsAffected ?? 0), blanked });
  }
  return result;
}

/**
 * Phase 13 slice 13.2 (D1 = a, owner msg 1129): every API-sourced row of a Non-Authorized table whose
 * clock column is older than `API_DATA_RETENTION_DAYS` (III.E.4.d) is deleted -- or, for a row that
 * records the operator's own decision, has its API-sourced columns blanked -- plus the market
 * assignments pointing at deleted records. Rows the operator entered are untouched (`apiRowsWhere`);
 * nothing classified `authorized`/`not_api_data` is read. One `BEGIN IMMEDIATE` transaction on the
 * CALLER's connection -- which must be a dedicated one (review round 1: on the shared connection any
 * unrelated in-process write would join this transaction). Nothing expiring -> no lock taken at all.
 * The caller takes the backup first.
 */
export async function purgeExpiredApiData(client: SqlExecutor, now: Date = new Date(), hooks: PurgeHooks = {}): Promise<PurgeResult> {
  const cutoffSeconds = cutoffFor(now);
  if (!(await anyExpiring(client, cutoffSeconds))) {
    return (await presentTables(client)).map((t) => ({ table: t.table, deleted: 0, blanked: 0 }));
  }
  await client.execute("BEGIN IMMEDIATE");
  try {
    if (hooks.beforePurge) await hooks.beforePurge();
    const result = await applyPurge(client, cutoffSeconds);
    if (hooks.afterPurge) await hooks.afterPurge();
    await client.execute("COMMIT");
    return result;
  } catch (error) {
    await client.execute("ROLLBACK");
    throw error;
  }
}

/**
 * Owner instruction (msg 1139, item 3): data that expired on one computer must not come back with an
 * import from another. The import calls this INSIDE its own merge transaction, after the merge and
 * before it records the lineage fingerprint -- so the imported state never contains expired rows.
 */
export async function purgeExpiredApiDataWithinTransaction(client: SqlExecutor, now: Date = new Date()): Promise<PurgeResult> {
  return applyPurge(client, cutoffFor(now));
}

/**
 * Owner instruction (msg 1139, item 2): backups follow the 30-day rule too. A backup file is not
 * deleted (it also holds the operator's own data) -- its expired other-channel API rows are purged
 * the same way as the live database's, and the file is VACUUMed so the deleted rows' pages are
 * really overwritten. A file that predates some tables is handled (missing tables are skipped).
 */
export async function scrubBackupFile(dbPath: string, now: Date = new Date()): Promise<{ changed: boolean }> {
  const client = createClient({ url: `file:${dbPath}` });
  try {
    await client.execute("PRAGMA busy_timeout = 5000");
    const cutoffSeconds = cutoffFor(now);
    if (!(await anyExpiring(client, cutoffSeconds))) return { changed: false };
    await client.execute("BEGIN IMMEDIATE");
    try {
      await applyPurge(client, cutoffSeconds);
      await client.execute("COMMIT");
    } catch (error) {
      await client.execute("ROLLBACK");
      throw error;
    }
    await client.execute("VACUUM");
    return { changed: true };
  } finally {
    client.close();
  }
}
