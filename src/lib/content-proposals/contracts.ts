import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";
import type { CreatedVia, EvidenceReference } from "@/lib/shared-provenance";
import type { CreativeAsset } from "@/lib/asset-catalog";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };
// Reused as-is from `@/lib/shared-provenance` (AGENTS.md §D/§M) -- shared with `ai-localization`
// (Phase 7 slice F), not a second copy of the same vocabulary.
export type { CreatedVia, EvidenceReference };

// ---------------------------------------------------------------------------
// Phase 7 slice G (owner spec §18/§19/§20) -- Content Proposal / external artifact registration.
//
// A Content Proposal is a structured, agent-authored (or human-authored) idea for a piece of
// content -- "the application does not need to generate every resulting asset. Codex or external
// tools may create the content." This module owns exactly the proposal RECORD -- it never
// generates, fetches, or produces any content itself (no media pipeline, no YouTube write).
//
// Deliberately WRITE-ONCE (owner spec describes no approval/review workflow for proposals, unlike
// Change Sets): create, get, list only. No update, no status field -- inventing an
// approval/review state machine the spec never asked for would be scope creep (`AGENTS.md` §C).
// A proposal is a DRAFT object, full stop; `GRANTED_PERMISSIONS` remains `["READ","DRAFT"]`.
//
// §20 (Experiment context, explicitly deferred to Phase 10) only asks that this schema not make
// it IMPOSSIBLE to later link proposal -> decision -> assets -> published video -> experiment ->
// analytics. Satisfied here by: `referenceAssetIds`/`referenceVideoIds` (existing links) plus this
// proposal's own stable `proposalId` (a future link target) -- nothing more is built now.
// ---------------------------------------------------------------------------

/**
 * The heterogeneous, low-cardinality remainder of owner spec §18's field list -- proposed title
 * direction, thumbnail direction, visual/audio brief, duration, publication hypothesis,
 * localization strategy, experiment design, expected metrics, required production outputs. None
 * of these is queried structurally anywhere in this codebase, so they are collapsed into one
 * bounded, `.strict()`-validated object rather than ~10 speculative dedicated columns
 * (`docs/DEVELOPMENT_PLAYBOOK.md` §6.2's schema discipline) -- every key here is named and
 * bounded, never an open `z.record` (never persist arbitrary unbounded content, AGENTS.md §B).
 * `expectedMetrics`/`publicationHypothesis` are `HYPOTHESIS`-class information (owner spec §6):
 * an agent's own prediction, never a server-verified fact -- see `docs/AGENT_OPERATIONS_INTERFACE.md`
 * §5's context-model classification.
 */
export type ContentProposalBrief = {
  proposedTitleDirection?: string | null;
  thumbnailDirection?: string | null;
  visualBrief?: string | null;
  audioBrief?: string | null;
  durationHint?: string | null;
  publicationHypothesis?: string | null;
  localizationStrategy?: string | null;
  experimentDesign?: string | null;
  expectedMetrics?: string[] | null;
  requiredProductionOutputs?: string[] | null;
};

export type ContentProposal = {
  proposalId: string;
  channelId: string;
  objective: string | null;
  topicConcept: string | null;
  rationale: string | null;
  /** Same shape and never-independently-verified caveat as `ai-localization`'s own evidence
   * field (Phase 7 slice F) -- owner spec §13's evidence model applied here too. */
  evidence: EvidenceReference[] | null;
  brief: ContentProposalBrief | null;
  /** Every id here is validated, at creation time, to actually belong to `channelId` (`AGENTS.md`
   * §F) -- never merely stored as an opaque caller-supplied string. */
  referenceVideoIds: string[] | null;
  referenceAssetIds: string[] | null;
  createdAt: string;
  /** SERVER-STAMPED at the MCP/CLI call site, never taken from caller input (owner spec §22) --
   * same attestation discipline as `ai-localization`'s `DraftProvenance.createdVia`. Unlike that
   * field, this is NOT NULL from the start: `content_proposals` is a brand-new table with no
   * pre-existing rows created before this field existed. */
  createdVia: CreatedVia;
  agentApiVersion: string | null;
};

/**
 * Owner spec §19 -- "a lightweight way for external agent workflows to return created artifacts
 * to the system": links an artifact already catalogued via `asset-catalog`'s own `registerAsset`
 * (AGENTS.md §D: this module never inserts into `creative_assets` itself, never a second,
 * parallel asset-insert path) back to the Content Proposal that requested it. This module owns
 * only the LINK -- the actual asset row, and everything about `referenceValue`/`referenceKind`
 * resolution, remains entirely `asset-catalog`'s own responsibility.
 *
 * Agent-callable registration (unlike the pre-existing, operator-only `asset register` CLI
 * command) is deliberately restricted to `referenceKind` values `"url"`/`"external_artifact_id"`
 * -- never `"local_path"` (owner spec §17: "the agent should receive only explicitly
 * cataloged/authorized assets"; an agent that could register its own `local_path` would be
 * self-authorizing filesystem access this application never explicitly granted it).
 */
export type ProposalArtifactLink = {
  linkId: string;
  proposalId: string;
  channelId: string;
  asset: CreativeAsset;
  createdAt: string;
  createdVia: CreatedVia;
  agentApiVersion: string | null;
};
