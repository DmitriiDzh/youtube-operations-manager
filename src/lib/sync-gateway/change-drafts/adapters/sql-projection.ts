import {
  deleteStoredChange,
  deleteStoredChangeSet,
  deleteStoredGenerationProvenanceForChangeSet,
  setStoredGenerationProvenanceRow,
  upsertStoredChange,
  upsertStoredChangeSet,
} from "@/lib/db";
import type { DraftChange, DraftChangeSet, DraftProvenance } from "../contracts";

/**
 * CD2's SQL read-projection (AUTOMERGE_MIGRATION_PLAN.md §6): writes the Automerge document's
 * current state into the existing `change_sets`/`changes` SQL tables, via `src/lib/db.ts`'s own
 * upsert functions -- never a second SQLite connection (AGENTS.md §D). This is what lets the
 * existing Web UI/API/MCP/CLI query surface keep working unchanged against SQL once this module
 * becomes the source of truth: nothing on the read side needs to know Automerge exists.
 *
 * `deleteChangeSet`/`deleteChange` exist ONLY for RISK-46's `discardLocalAndAdoptPeer` (the one
 * operation that can genuinely remove a row from the document's own key set, by replacing the
 * whole document) -- never called from the normal create/add/update/merge write paths, which
 * only ever grow the projection.
 */
export type SqlProjectionAdapter = {
  upsertChangeSet(changeSet: DraftChangeSet): Promise<void>;
  upsertChange(change: DraftChange): Promise<void>;
  deleteChangeSet(changeSetId: string): Promise<void>;
  deleteChange(changeId: string): Promise<void>;
  upsertProvenance(provenance: DraftProvenance): Promise<void>;
  /**
   * The only provenance deletion this module ever performs -- not because provenance itself is
   * mutable (it isn't, write-once, M4), but because `discardLocalAndAdoptPeer` can discard a
   * whole document, including whatever provenance entries it held, and `deleteChangeSet` fails
   * a real FK constraint (`ai_localization_generation_provenance.change_set_id REFERENCES
   * change_sets(id)`, no `ON DELETE`) if a referencing provenance row isn't removed first.
   */
  deleteProvenanceForChangeSet(changeSetId: string): Promise<void>;
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

    async deleteChangeSet(changeSetId: string): Promise<void> {
      await deleteStoredChangeSet(changeSetId);
    },

    async deleteChange(changeId: string): Promise<void> {
      await deleteStoredChange(changeId);
    },

    async upsertProvenance(provenance: DraftProvenance): Promise<void> {
      await setStoredGenerationProvenanceRow({
        id: provenance.id,
        changeSetId: provenance.changeSetId,
        channelId: provenance.channelId,
        profileVersion: provenance.profileVersion,
        effectiveContextJson: provenance.effectiveContextJson,
        createdAt: new Date(provenance.createdAt),
        // `?? null`, not a direct pass-through: an entry saved before Phase 7 slice F added
        // these fields (Automerge has no schema migration) simply lacks the key, reading as
        // `undefined` -- normalized to `null` here so this SQL write never receives `undefined`.
        evidenceJson: provenance.evidenceJson ?? null,
        rationale: provenance.rationale ?? null,
        createdVia: provenance.createdVia ?? null,
        agentApiVersion: provenance.agentApiVersion ?? null,
      });
    },

    async deleteProvenanceForChangeSet(changeSetId: string): Promise<void> {
      await deleteStoredGenerationProvenanceForChangeSet(changeSetId);
    },
  };
}
