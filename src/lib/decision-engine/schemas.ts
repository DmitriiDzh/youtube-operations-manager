import { z } from "zod";
import { EXPERIMENT_OUTCOME_CRITERIA_MET, EXPERIMENT_STATUSES } from "./contracts";

export { parseWithSchema, formatZodError } from "./contracts";

export const createHypothesisInputSchema = z
  .object({
    channelId: z.string().min(1).nullable().optional(),
    statement: z.string().min(1, "statement is required"),
    evidenceNotes: z.string().min(1, "evidenceNotes is required"),
  })
  .strict();

export const createExperimentInputSchema = z
  .object({
    treatment: z.string().min(1, "treatment is required"),
    controlBaseline: z.string().min(1, "controlBaseline is required"),
    successCriteria: z.string().min(1, "successCriteria is required"),
    stoppingCriteria: z.string().min(1, "stoppingCriteria is required"),
    startConditions: z.string().min(1).optional(),
    plannedDuration: z.string().min(1).optional(),
    sampleCoverageConstraints: z.string().min(1).optional(),
    budgetEstimate: z.string().min(1).optional(),
    responsible: z.string().min(1, "responsible is required"),
  })
  .strict();

export const transitionExperimentInputSchema = z
  .object({
    targetStatus: z.enum(EXPERIMENT_STATUSES),
  })
  .strict();

export const createExperimentOutcomeInputSchema = z
  .object({
    outcomeData: z.string().min(1, "outcomeData is required"),
    dataQualityLimitations: z.string().min(1).optional(),
    criteriaMet: z.enum(EXPERIMENT_OUTCOME_CRITERIA_MET),
    lessonsLearned: z.string().min(1).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 10 slice 2 (docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md) -- agent-facing MCP/CLI input
// shapes. `agentGetHypothesisTrailInputSchema` and `createExperimentProposalInputSchema` are
// specific to the agent surface (a single combined "trail" read, and an experiment proposal that
// must name which hypothesis it belongs to) -- the plain list/get/create schemas above stay as
// the Web UI's own shapes, unchanged.
// ---------------------------------------------------------------------------

export const agentGetHypothesisTrailInputSchema = z
  .object({
    hypothesisId: z.string().min(1, "hypothesisId is required"),
  })
  .strict();

export const createExperimentProposalInputSchema = createExperimentInputSchema
  .extend({
    hypothesisId: z.string().min(1, "hypothesisId is required"),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 10 slice 3 (docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md) -- structured evidence
// references. Each identifying field mirrors a real field already returned by analytics'/
// market-intelligence's own existing read functions (contracts.ts's own block comment has the
// full rationale) -- this schema only shapes/requires them, it never validates existence (that
// happens in services.ts via the caller-supplied resolver, never here).
// ---------------------------------------------------------------------------

const evidenceReferenceSchema = z.discriminatedUnion("sourceType", [
  z
    .object({
      sourceType: z.literal("phase8_metric"),
      channelId: z.string().min(1),
      videoId: z.string().min(1),
      metricDate: z.string().min(1),
      metricName: z.string().min(1),
    })
    .strict(),
  z
    .object({
      sourceType: z.literal("phase9_channel_snapshot"),
      researchChannelId: z.string().min(1),
      snapshotId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      sourceType: z.literal("phase9_video_snapshot"),
      researchChannelId: z.string().min(1),
      snapshotId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      sourceType: z.literal("phase9_trend_candidate"),
      trendCandidateId: z.string().min(1),
    })
    .strict(),
]);

export const addHypothesisEvidenceInputSchema = z
  .object({
    reference: evidenceReferenceSchema,
    note: z.string().min(1).optional(),
  })
  .strict();
