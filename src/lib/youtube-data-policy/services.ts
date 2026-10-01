import type { SqlExecutor } from "@/lib/db-backup/contracts";
import { API_DATA_RETENTION_DAYS, nonAuthorizedTables } from "./contracts";

export type PurgeResult = { table: string; deleted: number }[];

type ExecuteResult = { rows: Array<Record<string, unknown>>; rowsAffected?: number };

/**
 * Phase 13 slice 13.2 (D1 = a, owner msg 1129): deletes every API-sourced row of a Non-Authorized
 * table whose clock column is older than `API_DATA_RETENTION_DAYS` (III.E.4.d), plus the market
 * assignments that pointed at deleted records. Rows the operator entered by hand are untouched
 * (`apiRowsWhere`), and nothing classified `authorized`/`not_api_data` is ever read here. One
 * transaction, so a failure leaves everything as it was. The caller takes the backup first.
 */
export async function purgeExpiredApiData(client: SqlExecutor, now: Date = new Date()): Promise<PurgeResult> {
  const cutoffSeconds = Math.floor(now.getTime() / 1000) - API_DATA_RETENTION_DAYS * 24 * 60 * 60;
  const result: PurgeResult = [];
  await client.execute("BEGIN IMMEDIATE");
  try {
    for (const t of nonAuthorizedTables()) {
      const where = `"${t.clockColumn}" < ?` + (t.apiRowsWhere ? ` AND (${t.apiRowsWhere})` : "");
      if (t.assignmentRecordKind) {
        await client.execute({
          sql: `DELETE FROM channel_record_assignments WHERE record_kind = ? AND record_id IN (SELECT id FROM "${t.table}" WHERE ${where})`,
          args: [t.assignmentRecordKind, cutoffSeconds],
        });
      }
      const deleted = (await client.execute({
        sql: `DELETE FROM "${t.table}" WHERE ${where}`,
        args: [cutoffSeconds],
      })) as ExecuteResult;
      result.push({ table: t.table, deleted: Number(deleted.rowsAffected ?? 0) });
    }
    await client.execute("COMMIT");
  } catch (error) {
    await client.execute("ROLLBACK");
    throw error;
  }
  return result;
}
