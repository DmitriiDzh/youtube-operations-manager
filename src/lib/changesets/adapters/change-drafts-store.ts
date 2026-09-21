import {
  getStoredChangeById,
  getStoredChangeSet,
  listStoredChangesByChangeSet,
  listStoredChangeSetsByChannel,
} from "@/lib/db";
import { createChangeDraftsCoreForProduction } from "@/lib/change-drafts";
import { DomainError } from "../contracts";

/**
 * The Automerge-backed replacement for `createChangeSetStoreAdapter` (`./store.ts`), wired in by
 * `../index.ts` (AUTOMERGE_MIGRATION_PLAN.md §6 CD2's cutover). `src/lib/changesets/services.ts`
 * itself is UNCHANGED by this cutover -- it only ever talks to this adapter's interface, which is
 * deliberately identical in shape to the old SQL-direct one, so no API route, MCP tool, or CLI
 * command needs to change either.
 *
 * Reads stay pointed directly at the existing SQL functions, unchanged: `src/lib/change-drafts/`
 * re-projects the `change_sets`/`changes` tables after every SUCCESSFUL write (AC-CRDT-04), so
 * there is no reason for a read to go through Automerge at all in the common case -- SQL is
 * exactly as fast and correct as it always was for reading. Only the four *write* methods are
 * re-pointed at `change-drafts/`, since that module is now the actual source of truth for this
 * data (`docs/decisions/0006-automerge-for-draft-layer.md`).
 *
 * This module's own write methods take only a `changeSetId`/`changeId` (never `channelId`) --
 * the exact shape `services.ts` already calls them with, unchanged. Since `change-drafts/`'s
 * document model is scoped per-channel, `channelId` must be resolved first; this uses the SQL
 * projection for that (a cheap indexed read) rather than adding a new lookup path. The projection
 * is NOT guaranteed to be in sync: `change-drafts/services.ts`'s `saveDocument` deliberately
 * isolates a projection failure (logs, never rethrows) so a transient DB error never fails a write
 * whose Automerge document already saved correctly. In the window after such a failure, SQL is
 * stale until the next successful write re-projects it, and a lookup here for a changeId/
 * changeSetId that exists in Automerge but never made it into SQL fails closed with `not_found`
 * (an acceptable, recoverable degradation, per that function's own doc comment -- not a lost
 * write).
 */
export function createAutomergeBackedChangeSetStoreAdapter() {
  const core = createChangeDraftsCoreForProduction();

  async function resolveChannelIdForChangeSet(changeSetId: string): Promise<string> {
    const changeSet = await getStoredChangeSet(changeSetId);
    if (!changeSet) {
      throw new DomainError({ code: "not_found", message: "Change set not found", details: { changeSetId } });
    }
    return changeSet.channelId;
  }

  async function resolveChannelIdForChange(changeId: string): Promise<string> {
    const change = await getStoredChangeById(changeId);
    if (!change) {
      throw new DomainError({ code: "not_found", message: "Change not found", details: { changeId } });
    }
    return resolveChannelIdForChangeSet(change.changeSetId);
  }

  return {
    async createChangeSetWithChanges(input: {
      id: string;
      channelId: string;
      source: string;
      status: string;
      importedFilename: string | null;
      schemaVersion: string | null;
      exportedAt: string | null;
      changes: Array<{
        id: string;
        videoId: string;
        language: string;
        field: "title" | "description";
        baselineValue: string;
        proposedValue: string;
        changeType: "add" | "modify" | "unchanged" | "delete";
        validationStatus: "valid" | "invalid";
        validationError: string | null;
        conflictStatus: "none" | "conflict";
      }>;
    }): Promise<void> {
      // Batched into one Automerge.change + one saveDocument call (change-drafts/services.ts's
      // own `createChangeSetWithChanges`) rather than one createChangeSet + N addChange + one
      // setChangeSetStatus call -- see that function's doc comment for why: the OLD direct-SQL
      // adapter wrapped the equivalent write in one db.transaction, and this is what preserves
      // that same all-or-nothing guarantee here.
      await core.createChangeSetWithChanges({
        channelId: input.channelId,
        changeSetId: input.id,
        source: input.source,
        importedFilename: input.importedFilename,
        schemaVersion: input.schemaVersion,
        exportedAt: input.exportedAt,
        initialStatus: input.status,
        changes: input.changes.map((change) => ({
          changeId: change.id,
          videoId: change.videoId,
          language: change.language,
          field: change.field,
          baselineValue: change.baselineValue,
          proposedValue: change.proposedValue,
          changeType: change.changeType,
          validationStatus: change.validationStatus,
          validationError: change.validationError,
          conflictStatus: change.conflictStatus,
        })),
      });
    },

    listChangeSetsByChannel: listStoredChangeSetsByChannel,
    getChangeSet: getStoredChangeSet,
    listChangesByChangeSet: listStoredChangesByChangeSet,

    async updateChangeSetStatus(changeSetId: string, status: string): Promise<void> {
      const channelId = await resolveChannelIdForChangeSet(changeSetId);
      await core.setChangeSetStatus({ channelId, changeSetId, status });
    },

    async updateChange(
      changeId: string,
      patch: Partial<{ conflictStatus: "none" | "conflict"; approvalStatus: "pending" | "approved" | "rejected"; approvedValue: string | null }>
    ): Promise<void> {
      const channelId = await resolveChannelIdForChange(changeId);
      await core.patchChange({ channelId, changeId, patch });
    },

    async bulkUpdateChanges(
      updates: Array<{
        id: string;
        patch: Partial<{ conflictStatus: "none" | "conflict"; approvalStatus: "pending" | "approved" | "rejected"; approvedValue: string | null }>;
      }>
    ): Promise<void> {
      if (updates.length === 0) return;
      // `services.ts`'s only callers of bulkUpdateChanges (loadRevalidated, approveAllValid,
      // rejectAllPending) always pass changes belonging to a single change set, hence a single
      // channel -- resolving once from the first update and batching the rest into one
      // Automerge.change + one saveDocument call (bulkPatchChanges) preserves the OLD direct-SQL
      // adapter's one-db.transaction all-or-nothing guarantee for this write.
      const channelId = await resolveChannelIdForChange(updates[0].id);
      await core.bulkPatchChanges({
        channelId,
        updates: updates.map((update) => ({ changeId: update.id, patch: update.patch })),
      });
    },
  };
}
