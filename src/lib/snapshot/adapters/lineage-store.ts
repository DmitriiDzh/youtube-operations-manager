import type { SqlExecutor } from "../contracts";
import { isMissingTableError } from "@/lib/db-backup";

const ROW_ID = "singleton";

export type LineageState = {
  lastSnapshotId: string | null;
  lastGeneration: number;
  /**
   * Automatic device sync (schema v36, docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md §2): the
   * content fingerprint of this device's transferred tables at `lastSnapshotId`. `null` = unknown
   * (a lineage written before v36), which callers must treat as "local has unpublished changes".
   */
  contentFingerprint?: string | null;
  /** Ancestors of `lastSnapshotId`, newest first (§3.1). Empty when unknown. */
  ancestors?: string[];
};

type ExecuteResult = { rows: Array<Record<string, unknown>> };

async function execute(client: SqlExecutor, query: string | { sql: string; args?: unknown[] }) {
  return (await client.execute(query)) as ExecuteResult;
}

function parseAncestors(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function isMissingColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such column/i.test(message);
}

const EMPTY_LINEAGE: LineageState = { lastSnapshotId: null, lastGeneration: 0, contentFingerprint: null, ancestors: [] };

/** This device's own position in the snapshot lineage chain -- never transferred (see
 * SNAPSHOT_TRANSFERRED_TABLES; `snapshot_lineage` is deliberately not on that allowlist). */
export async function readLineageState(client: SqlExecutor): Promise<LineageState> {
  try {
    let result: ExecuteResult;
    try {
      result = await execute(client, {
        sql: "SELECT last_snapshot_id, last_generation, content_fingerprint, ancestors_json FROM snapshot_lineage WHERE id = ?",
        args: [ROW_ID],
      });
    } catch (error) {
      // A database not yet migrated to v36.
      if (!isMissingColumnError(error)) throw error;
      result = await execute(client, {
        sql: "SELECT last_snapshot_id, last_generation FROM snapshot_lineage WHERE id = ?",
        args: [ROW_ID],
      });
    }
    if (result.rows.length === 0) return { ...EMPTY_LINEAGE };
    const row = result.rows[0];
    return {
      lastSnapshotId: (row.last_snapshot_id as string | null) ?? null,
      lastGeneration: Number(row.last_generation),
      contentFingerprint: (row.content_fingerprint as string | null | undefined) ?? null,
      ancestors: parseAncestors(row.ancestors_json),
    };
  } catch (error) {
    if (isMissingTableError(error)) return { ...EMPTY_LINEAGE };
    throw error;
  }
}

/**
 * Writes the lineage pointer, its content fingerprint and its ancestry in ONE statement, so the
 * pointer and the fingerprint can never disagree (DEVICE_AUTO_SYNC_PLAN.md §2). A caller that does
 * not know the fingerprint passes nothing, which stores NULL -- "unknown", read as dirty.
 */
export async function writeLineageState(client: SqlExecutor, state: LineageState): Promise<void> {
  await execute(client, {
    sql:
      "INSERT INTO snapshot_lineage (id, last_snapshot_id, last_generation, content_fingerprint, ancestors_json) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET last_snapshot_id = excluded.last_snapshot_id, last_generation = excluded.last_generation, " +
      "content_fingerprint = excluded.content_fingerprint, ancestors_json = excluded.ancestors_json",
    args: [
      ROW_ID,
      state.lastSnapshotId,
      state.lastGeneration,
      state.contentFingerprint ?? null,
      JSON.stringify(state.ancestors ?? []),
    ],
  });
}
