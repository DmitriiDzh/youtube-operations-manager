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

/**
 * Phase 13 slice 13.2 (D1 = a, owner msg 1129): every API-sourced row of a Non-Authorized table whose
 * clock column is older than `API_DATA_RETENTION_DAYS` (III.E.4.d) is deleted -- or, for a row that
 * records the operator's own decision, has its API-sourced columns blanked -- plus the market
 * assignments pointing at deleted records. Rows the operator entered are untouched (`apiRowsWhere`);
 * nothing classified `authorized`/`not_api_data` is read. One `BEGIN IMMEDIATE` transaction on the
 * CALLER's connection -- which must be a dedicated one (review round 1: on the shared connection any
 * unrelated in-process write would join this transaction). The caller takes the backup first.
 */
async function anyExpiring(client: SqlExecutor, cutoffSeconds: number): Promise<boolean> {
  for (const t of nonAuthorizedTables()) {
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

export async function purgeExpiredApiData(client: SqlExecutor, now: Date = new Date(), hooks: PurgeHooks = {}): Promise<PurgeResult> {
  const cutoffSeconds = Math.floor(now.getTime() / 1000) - API_DATA_RETENTION_DAYS * 24 * 60 * 60;
  const result: PurgeResult = [];
  // Review round 2: nothing expiring -> no write lock and no fingerprint hashing at all.
  if (!(await anyExpiring(client, cutoffSeconds))) {
    return nonAuthorizedTables().map((t) => ({ table: t.table, deleted: 0, blanked: 0 }));
  }
  await client.execute("BEGIN IMMEDIATE");
  try {
    if (hooks.beforePurge) await hooks.beforePurge();
    for (const t of nonAuthorizedTables()) {
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
      if (t.assignmentRecordKind) {
        await client.execute({
          sql: `DELETE FROM channel_record_assignments WHERE record_kind = ? AND record_id IN (SELECT id FROM "${t.table}" WHERE ${deletable})`,
          args: [t.assignmentRecordKind, cutoffSeconds],
        });
      }
      const deleted = (await client.execute({ sql: `DELETE FROM "${t.table}" WHERE ${deletable}`, args: [cutoffSeconds] })) as ExecuteResult;
      result.push({ table: t.table, deleted: Number(deleted.rowsAffected ?? 0), blanked });
    }
    if (hooks.afterPurge) await hooks.afterPurge();
    await client.execute("COMMIT");
  } catch (error) {
    await client.execute("ROLLBACK");
    throw error;
  }
  return result;
}
