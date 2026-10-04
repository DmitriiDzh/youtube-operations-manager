import {
  deleteStoredBatchesWithChildren,
  getDraftRetentionDays,
  getWriteLogRetentionDays,
  listStoredBatchesByChannel,
  listStoredChangeSetsByChannel,
  listStoredChangesByChangeSet,
  listStoredLedgerRowsByBatch,
} from "@/lib/db";
import type { RetentionDependencies } from "../services";

/** Reads the facts the planner needs from the SQL projection (the same tables the Web UI, API and MCP read) via `src/lib/db.ts`. */
export function createSqlRetentionSource(): Pick<RetentionDependencies, "source" | "writeLog" | "settings"> {
  return {
    source: {
      async listChangeSets(channelId) {
        const sets = await listStoredChangeSetsByChannel(channelId);
        return Promise.all(
          sets.map(async (set) => ({
            id: set.id,
            status: set.status,
            updatedAt: set.updatedAt,
            changes: (await listStoredChangesByChangeSet(set.id)).map((change) => ({
              id: change.id,
              approvalStatus: change.approvalStatus,
              updatedAt: change.updatedAt,
            })),
          }))
        );
      },
      async listLedgerRows(channelId) {
        const batches = await listStoredBatchesByChannel(channelId);
        const rows = await Promise.all(
          batches.map(async (batch) =>
            (await listStoredLedgerRowsByBatch(batch.id)).map((row) => ({
              id: row.id,
              batchId: batch.id,
              status: row.status as string,
              changeIds: row.changeIds,
              updatedAt: row.updatedAt,
              batchDryRun: batch.dryRun,
            }))
          )
        );
        return rows.flat();
      },
      async listBatches(channelId) {
        const batches = await listStoredBatchesByChannel(channelId);
        return Promise.all(
          batches.map(async (batch) => ({
            id: batch.id,
            status: batch.status as string,
            completedAt: batch.completedAt,
            rows: (await listStoredLedgerRowsByBatch(batch.id)).map((row) => ({ status: row.status as string, changeIds: row.changeIds })),
          }))
        );
      },
    },
    writeLog: { deleteBatches: (batchIds) => deleteStoredBatchesWithChildren(batchIds) },
    settings: { draftRetentionDays: () => getDraftRetentionDays(), writeLogRetentionDays: () => getWriteLogRetentionDays() },
  };
}
