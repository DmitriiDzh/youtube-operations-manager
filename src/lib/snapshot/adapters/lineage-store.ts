import type { SqlExecutor } from "../contracts";

const ROW_ID = "singleton";

export type LineageState = {
  lastSnapshotId: string | null;
  lastGeneration: number;
};

type ExecuteResult = { rows: Array<Record<string, unknown>> };

async function execute(client: SqlExecutor, query: string | { sql: string; args?: unknown[] }) {
  return (await client.execute(query)) as ExecuteResult;
}

/** True only for "the snapshot_lineage table doesn't exist yet" (a database that hasn't run
 * that migration). Any other failure must propagate, not be reported as "never imported
 * before" -- see verifySnapshotForImport's own use of `lastSnapshotId === null` as
 * `isFirstEverImport`, which bypasses the divergent-lineage check entirely; a transient read
 * error silently masquerading as that would let a genuinely divergent/forked snapshot through
 * (found by independent review). */
function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table/i.test(message);
}

/** This device's own position in the snapshot lineage chain -- never transferred (see
 * SNAPSHOT_TRANSFERRED_TABLES; `snapshot_lineage` is deliberately not on that allowlist). */
export async function readLineageState(client: SqlExecutor): Promise<LineageState> {
  try {
    const result = await execute(client, {
      sql: "SELECT last_snapshot_id, last_generation FROM snapshot_lineage WHERE id = ?",
      args: [ROW_ID],
    });
    if (result.rows.length === 0) return { lastSnapshotId: null, lastGeneration: 0 };
    return {
      lastSnapshotId: (result.rows[0].last_snapshot_id as string | null) ?? null,
      lastGeneration: Number(result.rows[0].last_generation),
    };
  } catch (error) {
    if (isMissingTableError(error)) return { lastSnapshotId: null, lastGeneration: 0 };
    throw error;
  }
}

export async function writeLineageState(client: SqlExecutor, state: LineageState): Promise<void> {
  await execute(client, {
    sql:
      "INSERT INTO snapshot_lineage (id, last_snapshot_id, last_generation) VALUES (?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET last_snapshot_id = excluded.last_snapshot_id, last_generation = excluded.last_generation",
    args: [ROW_ID, state.lastSnapshotId, state.lastGeneration],
  });
}
