import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";
import type {
  ChangeApprovalStatus,
  ChangeConflictStatus,
  ChangeField,
  ChangeSetSource,
  ChangeSetStatus,
  ChangeType,
  ChangeValidationStatus,
} from "@/lib/changesets/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

// Reused as-is from src/lib/changesets/contracts.ts (AGENTS.md §D) -- this module is a new
// *storage/sync* layer for the same draft concepts, not a new vocabulary for them.
export type {
  ChangeApprovalStatus,
  ChangeConflictStatus,
  ChangeField,
  ChangeSetSource,
  ChangeSetStatus,
  ChangeType,
  ChangeValidationStatus,
};

/**
 * CD1's spike (docs/roadmap/plans/AUTOMERGE_MIGRATION_PLAN.md §3) confirmed this shape against
 * real Automerge 3.x behavior: different-field concurrent edits merge automatically; same-field
 * concurrent edits keep both values recoverable via `getConflicts` even though a deterministic
 * "current" value is always readable. Every field here maps 1:1 onto `src/lib/db.ts`'s `changes`
 * table columns (`AUTOMERGE_MIGRATION_PLAN.md` §6 CD4's lossless-migration requirement) -- do not
 * add a field here without a corresponding SQL column, or vice versa, without updating both.
 */
export type DraftChange = {
  id: string;
  changeSetId: string;
  videoId: string;
  language: string;
  field: ChangeField;
  baselineValue: string;
  proposedValue: string;
  changeType: ChangeType;
  validationStatus: ChangeValidationStatus;
  validationError: string | null;
  conflictStatus: ChangeConflictStatus;
  approvalStatus: ChangeApprovalStatus;
  approvedValue: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DraftChangeSet = {
  id: string;
  channelId: string;
  source: ChangeSetSource;
  status: ChangeSetStatus;
  importedFilename: string | null;
  schemaVersion: string | null;
  exportedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The Automerge document shape for exactly one channel's drafts
 * (`AUTOMERGE_MIGRATION_PLAN.md` §5 -- "one Automerge document per channel," the natural
 * sync/conflict boundary this codebase already uses for write-safety, `write-context`).
 * `channelId` here is a data-partitioning convenience only -- never an access-control decision;
 * `write-context.assertWriteChannel` remains the sole identity authority (AC-CRDT-06).
 */
export type ChannelDraftDocument = {
  channelId: string;
  changeSets: Record<string, DraftChangeSet>;
  changes: Record<string, DraftChange>;
};

/**
 * One field-level conflict found after a merge: two (or more) concurrently-written values for
 * the same property of the same `DraftChange`, keyed by the Automerge actor/change id that wrote
 * each one (opaque identifiers -- not meant to be human-readable, just distinct and stable enough
 * to display "version A" / "version B" style choices in a future conflict-resolution UI, CD6).
 * AC-CRDT-02: nothing here is ever silently discarded -- every concurrently-written value that
 * exists is represented in `valuesByActor`.
 *
 * Note for CD6 (the conflict-resolution UI): `updatedAt` is deliberately excluded from
 * conflict *detection* (`services.ts`'s `MUTABLE_CHANGE_FIELDS`, to avoid every ordinary
 * concurrent edit spuriously conflicting on its own bookkeeping timestamp) -- but a per-value
 * timestamp is still exactly what a human needs to tell "version A (edited 14:32)" from
 * "version B (edited 14:35)" when choosing between them. That timestamp remains separately
 * recoverable via `Automerge.getConflicts(change, "updatedAt")` on the same change even though
 * it never appears inside a `FieldConflict` itself -- CD6 needs to fetch it explicitly, it will
 * not arrive bundled with the `proposedValue`/etc. conflict this type describes.
 */
export type FieldConflict = {
  changeId: string;
  field: keyof DraftChange;
  valuesByActor: Record<string, unknown>;
};

export type MergeResult = {
  newConflicts: FieldConflict[];
};
