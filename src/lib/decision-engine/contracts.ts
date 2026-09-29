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
