import { upsertStoredChange, upsertStoredChangeSet } from "@/lib/db";
import type { DraftChange, DraftChangeSet } from "../contracts";

/**
 * CD2's SQL read-projection (AUTOMERGE_MIGRATION_PLAN.md §6): writes the Automerge document's
 * current state into the existing `change_sets`/`changes` SQL tables, via `src/lib/db.ts`'s own
 * upsert functions -- never a second SQLite connection (AGENTS.md §D). This is what lets the
 * existing Web UI/API/MCP/CLI query surface keep working unchanged against SQL once this module
 * becomes the source of truth: nothing on the read side needs to know Automerge exists.
 */
export type SqlProjectionAdapter = {
  upsertChangeSet(changeSet: DraftChangeSet): Promise<void>;
  upsertChange(change: DraftChange): Promise<void>;
};

export function createSqlProjectionAdapter(): SqlProjectionAdapter {
  return {
    async upsertChangeSet(changeSet: DraftChangeSet): Promise<void> {
      await upsertStoredChangeSet({
        id: changeSet.id,
        channelId: changeSet.channelId,
        source: changeSet.source,
        status: changeSet.status,
        importedFilename: changeSet.importedFilename,
        schemaVersion: changeSet.schemaVersion,
        exportedAt: changeSet.exportedAt,
        createdAt: new Date(changeSet.createdAt),
        updatedAt: new Date(changeSet.updatedAt),
      });
    },

    async upsertChange(change: DraftChange): Promise<void> {
      await upsertStoredChange({
        id: change.id,
        changeSetId: change.changeSetId,
        videoId: change.videoId,
        language: change.language,
        field: change.field,
        baselineValue: change.baselineValue,
        proposedValue: change.proposedValue,
        changeType: change.changeType,
        validationStatus: change.validationStatus,
        validationError: change.validationError,
        conflictStatus: change.conflictStatus,
        approvalStatus: change.approvalStatus,
        approvedValue: change.approvedValue,
        createdAt: new Date(change.createdAt),
        updatedAt: new Date(change.updatedAt),
      });
    },
  };
}
