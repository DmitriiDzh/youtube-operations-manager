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
