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
import type { CreatedVia } from "@/lib/shared-provenance";

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
 * AI-generation provenance for one change set -- write-once (never updated or deleted through
 * this module's own API), folded into this document 2026-09-22
 * (`docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4/M4, Category C) rather than
 * given its own document family, since it is already intrinsically per-channel (via its parent
 * change set) and purely additive to a change set's own existence. 1:1 with
 * `src/lib/db.ts`'s `ai_localization_generation_provenance` columns.
 */
export type DraftProvenance = {
  id: string;
  changeSetId: string;
  channelId: string;
  profileVersion: number | null;
  effectiveContextJson: string | null;
  createdAt: string;
  /** Phase 7 slice F (owner spec §13) -- JSON-encoded `EvidenceReference[]`, agent-supplied
   * external research citations. `null` when none were supplied -- never fabricated. Every NEW
   * write via `createProvenance` always sets this to a concrete value (a string or `null`), but
   * the field is typed OPTIONAL here because Automerge has no schema migration
   * (`ChannelDraftDocument.provenance?`'s own doc comment applies identically to entries, not
   * just to the map itself): an entry created before this field existed simply lacks the key
   * entirely, reading as `undefined`, not `null` -- every reader (`upsertProvenance`) must
   * normalize with `?? null` rather than assume the key is always present. */
  evidenceJson?: string | null;
  /** Phase 7 slice F (owner spec §12) -- agent-supplied rationale for the generated proposals.
   * Never independently verified by this server (same caveat as `effectiveContextJson`). Same
   * pre-existing-entry caveat as `evidenceJson` above. */
  rationale?: string | null;
  /** Phase 7 slice F (owner spec §22) -- which transport actually created this Change Set.
   * SERVER-STAMPED at the MCP/CLI/Web-route call site, never taken from caller input (that would
   * make it a claim, not an attestation -- see `docs/TECHNICAL_DEBT.md` RISK-54's own reasoning
   * for why this distinction matters). Same pre-existing-entry caveat as `evidenceJson` above. */
  createdVia?: CreatedVia | null;
  /** Phase 7 slice F -- `AGENT_API_VERSION` (`src/lib/agent-operations/contracts.ts`) at creation
   * time, SERVER-STAMPED, only when `createdVia` is `"mcp"` (the one transport where an
   * agent-operations-versioned surface actually mediated the call) -- `null` otherwise. Same
   * pre-existing-entry caveat as `evidenceJson` above. */
  agentApiVersion?: string | null;
};

/**
 * The Automerge document shape for exactly one channel's drafts
 * (`AUTOMERGE_MIGRATION_PLAN.md` §5 -- "one Automerge document per channel," the natural
 * sync/conflict boundary this codebase already uses for write-safety, `write-context`).
 * `channelId` here is a data-partitioning convenience only -- never an access-control decision;
 * `write-context.assertWriteChannel` remains the sole identity authority (AC-CRDT-06).
 *
 * `provenance` was added 2026-09-22 (M4), AFTER real documents already existed on real devices
 * without it -- Automerge has no schema-migration mechanism, so a document saved before this
 * field existed simply lacks the key entirely. `provenance` is therefore typed optional here,
 * and every read of it in `services.ts` defaults to `{}` rather than assuming it is present
 * (mirrors this project's own additive-schema philosophy for SQL,
 * `docs/decisions/0001-additive-idempotent-schema-strategy.md`, applied here to an Automerge
 * document instead of a SQL table).
 */
export type ChannelDraftDocument = {
  channelId: string;
  changeSets: Record<string, DraftChangeSet>;
  changes: Record<string, DraftChange>;
  provenance?: Record<string, DraftProvenance>;
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
