import { listStoredChangeSetsByChannel, listStoredChangesByChangeSet } from "@/lib/db";
import type { DraftChange, DraftChangeSet } from "../contracts";

/**
 * CD4's read side (AUTOMERGE_MIGRATION_PLAN.md §6): reuses the existing `src/lib/db.ts` read
 * functions the `changesets` module already relies on -- never a second SQLite connection or a
 * duplicated query (AGENTS.md §D). This adapter only converts what `db.ts` already returns into
 * this module's own `DraftChangeSet`/`DraftChange` shape (`Date` -> ISO string, `source` narrowed
 * to `ChangeSetSource`); it contains no query logic of its own.
 */
export type SqlSourceAdapter = {
  listChangeSetsForChannel(channelId: string): Promise<DraftChangeSet[]>;
  listChangesForChangeSet(changeSetId: string): Promise<DraftChange[]>;
};

export function createSqlSourceAdapter(): SqlSourceAdapter {
  return {
    async listChangeSetsForChannel(channelId: string): Promise<DraftChangeSet[]> {
      const rows = await listStoredChangeSetsByChannel(channelId);
      return rows.map((row) => ({
        id: row.id,
        channelId: row.channelId,
        source: row.source as DraftChangeSet["source"],
        status: row.status,
        importedFilename: row.importedFilename,
        schemaVersion: row.schemaVersion,
        exportedAt: row.exportedAt,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
    },

    async listChangesForChangeSet(changeSetId: string): Promise<DraftChange[]> {
      const rows = await listStoredChangesByChangeSet(changeSetId);
      return rows.map((row) => ({
        id: row.id,
        changeSetId: row.changeSetId,
        videoId: row.videoId,
        language: row.language,
        field: row.field,
        baselineValue: row.baselineValue,
        proposedValue: row.proposedValue,
        changeType: row.changeType,
        validationStatus: row.validationStatus,
        validationError: row.validationError,
        conflictStatus: row.conflictStatus,
        approvalStatus: row.approvalStatus,
        approvedValue: row.approvedValue,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
    },
  };
}
