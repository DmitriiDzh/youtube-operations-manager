import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  createIdGenerator,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/video-metadata/contracts";
import {
  EXPERIMENT_STATUS_TRANSITIONS,
  EXPERIMENT_OUTCOME_RECORDABLE_STATUSES,
  type ExperimentStatus,
} from "./status";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError, createIdGenerator };

// ---------------------------------------------------------------------------
// Phase 10 slice 1 -- Decision & Experiment Engine, manual-entry record-keeping foundation
// (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md, FUTURE_PHASES.md §6). Owns `hypotheses`/
// `experiments`/`experiment_outcomes`. `channelId` on a hypothesis is nullable -- a "new channel
// concept" hypothesis has no existing owned channel yet.
//
// The status enum, transition table, and outcome-recordable-statuses list live in
// `./status.ts`, not here -- both this contracts.ts AND the
// "use client" `decisions-manager.tsx` need the identical table, and defining it twice was found
// by advisor review to be exactly the duplication-drift risk the Phase 9 Part II merge-review's
// finding #10 (`market-velocity-format.ts`) had just been fixed for.
// ---------------------------------------------------------------------------

export type { ExperimentStatus };
export { EXPERIMENT_STATUS_TRANSITIONS, EXPERIMENT_OUTCOME_RECORDABLE_STATUSES };
export const EXPERIMENT_STATUSES = ["proposed", "approved", "running", "concluded", "abandoned"] as const;

/** Phase 10 slice 5 -- how long an `executeExperiment` claim (`execution_claimed_at`) blocks other
 * transitions/detach before being treated as an abandoned (crashed) attempt and reclaimable. Same
 * 15-minute precedent already used by Phase 9 slice 9B's own market-intelligence collection claim
 * (`docs/ARCHITECTURE.md`'s claim-expiry note -- deliberately not named symbol-by-symbol here, to
 * avoid tripping `market-intelligence/write-path-inventory.test.ts`'s own naive whole-file
 * substring scan for that module's table names with a mere code comment) -- a crash must never
 * permanently lock an experiment out of its own normal lifecycle. */
export const EXPERIMENT_EXECUTION_CLAIM_EXPIRY_MS = 15 * 60 * 1000;

export const EXPERIMENT_OUTCOME_CRITERIA_MET = ["met", "not_met", "inconclusive"] as const;
export type ExperimentOutcomeCriteriaMet = (typeof EXPERIMENT_OUTCOME_CRITERIA_MET)[number];

export type Hypothesis = {
  hypothesisId: string;
  channelId: string | null;
  statement: string;
  evidenceNotes: string;
  createdBy: string;
  createdVia: string;
  createdAt: string;
};

export type Experiment = {
  experimentId: string;
  hypothesisId: string;
  treatment: string;
  controlBaseline: string;
  successCriteria: string;
  stoppingCriteria: string;
  startConditions: string | null;
  plannedDuration: string | null;
  sampleCoverageConstraints: string | null;
  budgetEstimate: string | null;
  responsible: string;
  status: ExperimentStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  changeSetId: string | null;
  executionBatchId: string | null;
  createdVia: string;
  createdAt: string;
};

export type ExperimentOutcome = {
  outcomeId: string;
  experimentId: string;
  recordedBy: string;
  recordedAt: string;
  outcomeData: string;
  dataQualityLimitations: string | null;
  criteriaMet: ExperimentOutcomeCriteriaMet;
  lessonsLearned: string | null;
  createdVia: string;
};

// ---------------------------------------------------------------------------
// Phase 10 slice 3 -- structured evidence references (docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md).
// `EvidenceReference` is a discriminated union of real identifying fields already returned by
// Phase 8 (`analytics`) / Phase 9 (`market-intelligence`)'s own existing read functions -- nothing
// invented. `EvidenceReferenceResolver` is a PORT this module defines but never implements: the
// real implementation is built by the route file (the interface layer), which is the only place
// allowed to import `@/lib/analytics`/`@/lib/market-intelligence` for this purpose. This module
// itself (`decision-engine/**`) must never import either -- `AGENTS.md` §M, the same
// module-independence rule `PHASE_9_PLAN.md` §5 already established for market-intelligence
// itself ("no existing route/service/component may take a hard dependency on market-intelligence's
// tables or services"), applied here in the new direction (decision-engine depending on them).
// ---------------------------------------------------------------------------

export const HYPOTHESIS_EVIDENCE_SOURCE_TYPES = [
  "phase8_metric",
  "phase9_channel_snapshot",
  "phase9_video_snapshot",
  "phase9_trend_candidate",
] as const;
export type HypothesisEvidenceSourceType = (typeof HYPOTHESIS_EVIDENCE_SOURCE_TYPES)[number];

export type EvidenceReference =
  | { sourceType: "phase8_metric"; channelId: string; videoId: string; metricDate: string; metricName: string }
  | { sourceType: "phase9_channel_snapshot"; researchChannelId: string; snapshotId: string }
  | { sourceType: "phase9_video_snapshot"; researchChannelId: string; snapshotId: string }
  | { sourceType: "phase9_trend_candidate"; trendCandidateId: string };

/** Implemented by the route file, never by this module -- see the block comment above. Each
 * method resolves `true` only if the referenced row genuinely exists (and, for `phase8_metric`,
 * only if the caller is actually authorized for that channel -- `analyticsCore.listMetrics`
 * already enforces this internally via its own `channelAccess.assertActiveChannel` call, so the
 * real implementation gets this for free by reusing that function rather than re-checking). */
export type EvidenceReferenceResolver = {
  resolve(reference: EvidenceReference, ctx: { userId: string | null | undefined }): Promise<boolean>;
  /** Phase 10 slice 4 -- a short, human/model-readable summary of one already-resolved reference
   * (e.g. "Video abc123: views = 12,400 on 2026-09-20"), fed into AI hypothesis generation as
   * plain text so the model never sees a raw DB row. Callers must call `resolve` first and only
   * describe a reference that resolved `true` -- this method does not re-validate existence. */
  describe(reference: EvidenceReference, ctx: { userId: string | null | undefined }): Promise<string>;
};

export type HypothesisEvidence = {
  evidenceId: string;
  hypothesisId: string;
  reference: EvidenceReference;
  note: string | null;
  createdVia: string;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Phase 10 slice 4 -- AI-generated hypothesis drafts (docs/roadmap/plans/PHASE_10_SLICE_4_PLAN.md).
// Mirrors `ai-localization/contracts.ts`'s `LocalizationProvider` shape exactly (`AGENTS.md` §D) --
// this module OWNS the request/outcome/provider types (the domain shape), `ai-connections`
// imports them (the transport side adapts INTO this shape), same direction as the existing
// LocalizationProvider/ai-connections relationship.
// ---------------------------------------------------------------------------

export type HypothesisGenerationTokenUsage = { inputTokens: number; outputTokens: number };

/** What the provider is given -- never a raw DB row, only the operator's own notes plus
 * already-resolved, human-readable summaries of evidence the operator selected before generation
 * (see `EvidenceReferenceResolver.describe` below). The model never sees, and never produces, an
 * `EvidenceReference` itself -- it cannot invent one, per the plan's own §3. */
export type HypothesisGenerationRequest = {
  channelId: string | null;
  notes: string;
  evidenceSummaries: string[];
};

export type HypothesisGenerationOutcome =
  | { status: "ok"; statement: string; rationale: string; usage?: HypothesisGenerationTokenUsage }
  | { status: "error"; message: string };

/** The replaceable extension point this slice adds, alongside `LocalizationProvider` -- a second
 * real caller of the same shared `ai-connections` transport infrastructure (`AGENTS.md` §M). */
export type HypothesisDraftProvider = {
  readonly name: string;
  generateHypothesis(request: HypothesisGenerationRequest): Promise<HypothesisGenerationOutcome>;
};

// ---------------------------------------------------------------------------
// Phase 10 slice 5 -- execution of an approved, localization-type experiment
// (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md). Same reasoning as `EvidenceReferenceResolver`
// above: a PORT this module defines but never implements. The real implementation (which imports
// `@/lib/changesets`/`@/lib/batches`) lives in the route layer, outside `decision-engine/**` --
// `PHASE10-INV-03` forbids this module from importing either directly, the same rule it already
// enforces for `analytics`/`market-intelligence`.
// ---------------------------------------------------------------------------

export type ExperimentExecutionResolver = {
  /** `true` only if `changeSetId` exists AND belongs to `channelId` -- the underlying real
   * `getChangeSet` action requires `channelId` up front (every one of its existing public methods
   * does), so there is no way to ask "which channel does this changeSetId belong to" independent
   * of a candidate channel; this asks the only question that's actually answerable, and the only
   * one either caller (`setExperimentChangeSet`/`executeExperiment`, both already holding the
   * experiment's own `hypothesis.channelId`) actually needs. */
  verifyChangeSetBelongsToChannel(changeSetId: string, channelId: string): Promise<boolean>;
  /** Groups the Change Set's own eligible (approved + valid + non-conflicting +
   * not-edited-after-approval) changes into a real Batch. Throws
   * `EXPERIMENT_CHANGE_SET_TOO_LARGE`/`EXPERIMENT_CHANGE_SET_NO_ELIGIBLE_CHANGES` rather than
   * silently truncating or failing with an opaque `createBatch` validation error. `dryRun` is
   * threaded through explicitly by the caller (§1 of the plan) -- this port has no opinion on
   * Live Writes itself. */
  createDryRunBatch(args: { channelId: string; changeSetId: string; dryRun: boolean }): Promise<{
    batchId: string;
    videoCount: number;
  }>;
};
