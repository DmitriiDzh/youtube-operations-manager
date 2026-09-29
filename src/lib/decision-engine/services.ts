import {
  DomainError,
  parseWithSchema,
  EXPERIMENT_OUTCOME_RECORDABLE_STATUSES,
  EXPERIMENT_STATUS_TRANSITIONS,
  type EvidenceReference,
  type EvidenceReferenceResolver,
  type Experiment,
  type ExperimentOutcome,
  type ExperimentStatus,
  type Hypothesis,
  type HypothesisEvidence,
} from "./contracts";
import {
  addHypothesisEvidenceInputSchema,
  createExperimentInputSchema,
  createExperimentOutcomeInputSchema,
  createHypothesisInputSchema,
  transitionExperimentInputSchema,
} from "./schemas";
import type {
  HypothesisEvidenceSourceType,
  StoredExperiment,
  StoredExperimentOutcome,
  StoredHypothesis,
  StoredHypothesisEvidence,
} from "@/lib/db";

type ChannelAccess = {
  assertActiveChannel(args: { userId: string | null | undefined; channelId: string }): Promise<string>;
  getActiveChannelId(userId: string | null | undefined): Promise<string | null>;
};

export type DecisionEngineServiceDependencies = {
  idGenerator(): string;
  clock: { now(): Date };
  channelAccess: ChannelAccess;
  insertHypothesis: (input: {
    id: string;
    channelId?: string | null;
    statement: string;
    evidenceNotes: string;
    createdBy: string;
    createdVia: string;
    at?: Date;
  }) => Promise<void>;
  getHypothesisById: (id: string) => Promise<StoredHypothesis | null>;
  listHypotheses: () => Promise<StoredHypothesis[]>;
  insertExperiment: (input: {
    id: string;
    hypothesisId: string;
    treatment: string;
    controlBaseline: string;
    successCriteria: string;
    stoppingCriteria: string;
    startConditions?: string | null;
    plannedDuration?: string | null;
    sampleCoverageConstraints?: string | null;
    budgetEstimate?: string | null;
    responsible: string;
    createdVia: string;
    at?: Date;
  }) => Promise<void>;
  getExperimentById: (id: string) => Promise<StoredExperiment | null>;
  listExperimentsByHypothesis: (hypothesisId: string) => Promise<StoredExperiment[]>;
  transitionExperimentStatusIfValid: (
    id: string,
    fromStatuses: ExperimentStatus[],
    toStatus: ExperimentStatus,
    approvedBy: string | null,
    at: Date
  ) => Promise<StoredExperiment | null>;
  insertExperimentOutcome: (input: {
    id: string;
    experimentId: string;
    recordedBy: string;
    outcomeData: string;
    dataQualityLimitations?: string | null;
    criteriaMet: "met" | "not_met" | "inconclusive";
    lessonsLearned?: string | null;
    createdVia: string;
    at?: Date;
  }) => Promise<void>;
  listExperimentOutcomesByExperiment: (experimentId: string) => Promise<StoredExperimentOutcome[]>;
  insertHypothesisEvidence: (input: {
    id: string;
    hypothesisId: string;
    sourceType: HypothesisEvidenceSourceType;
    referenceJson: string;
    note?: string | null;
    createdVia: string;
    at?: Date;
  }) => Promise<void>;
  listHypothesisEvidenceByHypothesis: (hypothesisId: string) => Promise<StoredHypothesisEvidence[]>;
};

function toHypothesis(row: StoredHypothesis): Hypothesis {
  return {
    hypothesisId: row.id,
    channelId: row.channelId,
    statement: row.statement,
    evidenceNotes: row.evidenceNotes,
    createdBy: row.createdBy,
    createdVia: row.createdVia,
    createdAt: row.createdAt.toISOString(),
  };
}

function toExperiment(row: StoredExperiment): Experiment {
  return {
    experimentId: row.id,
    hypothesisId: row.hypothesisId,
    treatment: row.treatment,
    controlBaseline: row.controlBaseline,
    successCriteria: row.successCriteria,
    stoppingCriteria: row.stoppingCriteria,
    startConditions: row.startConditions,
    plannedDuration: row.plannedDuration,
    sampleCoverageConstraints: row.sampleCoverageConstraints,
    budgetEstimate: row.budgetEstimate,
    responsible: row.responsible,
    status: row.status,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    createdVia: row.createdVia,
    createdAt: row.createdAt.toISOString(),
  };
}

function toExperimentOutcome(row: StoredExperimentOutcome): ExperimentOutcome {
  return {
    outcomeId: row.id,
    experimentId: row.experimentId,
    recordedBy: row.recordedBy,
    recordedAt: row.recordedAt.toISOString(),
    outcomeData: row.outcomeData,
    dataQualityLimitations: row.dataQualityLimitations,
    criteriaMet: row.criteriaMet,
    lessonsLearned: row.lessonsLearned,
    createdVia: row.createdVia,
  };
}

// `referenceJson` is trusted here -- it was already validated as real JSON matching
// `EvidenceReference`'s own shape by `addHypothesisEvidenceInputSchema` at write time, before
// this row was ever inserted (services.ts's own `addHypothesisEvidence`, not this function).
function toHypothesisEvidence(row: StoredHypothesisEvidence): HypothesisEvidence {
  return {
    evidenceId: row.id,
    hypothesisId: row.hypothesisId,
    reference: JSON.parse(row.referenceJson) as EvidenceReference,
    note: row.note,
    createdVia: row.createdVia,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Pure -- exported for direct, exhaustive (5x5) testing independent of any DB/service call. */
export function assertValidStatusTransition(from: ExperimentStatus, to: ExperimentStatus): void {
  const allowed = EXPERIMENT_STATUS_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new DomainError({
      code: "EXPERIMENT_INVALID_TRANSITION",
      message: `Cannot transition an experiment from "${from}" to "${to}"`,
      details: { from, to, allowed },
    });
  }
}

export function createDecisionEngineServices(deps: DecisionEngineServiceDependencies) {
  async function assertHypothesisAccessible(
    hypothesisId: string,
    ctx: { userId: string | null | undefined }
  ): Promise<StoredHypothesis> {
    const row = await deps.getHypothesisById(hypothesisId);
    if (!row) {
      throw new DomainError({ code: "HYPOTHESIS_NOT_FOUND", message: "Hypothesis not found", details: { hypothesisId } });
    }
    if (row.channelId) {
      await deps.channelAccess.assertActiveChannel({ userId: ctx.userId, channelId: row.channelId });
    }
    return row;
  }

  async function assertExperimentAccessible(
    experimentId: string,
    ctx: { userId: string | null | undefined }
  ): Promise<{ experiment: StoredExperiment; hypothesis: StoredHypothesis }> {
    const experiment = await deps.getExperimentById(experimentId);
    if (!experiment) {
      throw new DomainError({ code: "EXPERIMENT_NOT_FOUND", message: "Experiment not found", details: { experimentId } });
    }
    const hypothesis = await assertHypothesisAccessible(experiment.hypothesisId, ctx);
    return { experiment, hypothesis };
  }

  return {
    async createHypothesis(
      input: unknown,
      ctx: { userId: string | null | undefined; createdBy: string; createdVia: string }
    ): Promise<Hypothesis> {
      const parsed = parseWithSchema(createHypothesisInputSchema, input, "create hypothesis input");
      if (parsed.channelId) {
        await deps.channelAccess.assertActiveChannel({ userId: ctx.userId, channelId: parsed.channelId });
      }
      const id = deps.idGenerator();
      const at = deps.clock.now();
      await deps.insertHypothesis({
        id,
        channelId: parsed.channelId ?? null,
        statement: parsed.statement,
        evidenceNotes: parsed.evidenceNotes,
        createdBy: ctx.createdBy,
        createdVia: ctx.createdVia,
        at,
      });
      const row = await deps.getHypothesisById(id);
      if (!row) throw new DomainError({ code: "HYPOTHESIS_NOT_FOUND", message: "Hypothesis not found immediately after creation", details: { id } });
      return toHypothesis(row);
    },

    async getHypothesis(hypothesisId: string, ctx: { userId: string | null | undefined }): Promise<Hypothesis> {
      const row = await assertHypothesisAccessible(hypothesisId, ctx);
      return toHypothesis(row);
    },

    /** Channel-scoped rows are narrowed to the session's active channel; channel-less rows
     * (a "new channel concept" hypothesis) are always included -- there is nothing to scope them
     * by. Mirrors `channelAccess.filterToActiveChannel`'s own semantics for the non-null rows,
     * adapted for a nullable `channelId` that helper doesn't accept. */
    async listHypotheses(ctx: { userId: string | null | undefined }): Promise<Hypothesis[]> {
      const activeChannelId = await deps.channelAccess.getActiveChannelId(ctx.userId);
      const rows = await deps.listHypotheses();
      const filtered = rows.filter((row) => row.channelId === null || row.channelId === activeChannelId);
      return filtered.map(toHypothesis);
    },

    async createExperiment(
      hypothesisId: string,
      input: unknown,
      ctx: { userId: string | null | undefined; createdBy: string; createdVia: string }
    ): Promise<Experiment> {
      await assertHypothesisAccessible(hypothesisId, ctx);
      const parsed = parseWithSchema(createExperimentInputSchema, input, "create experiment input");
      const id = deps.idGenerator();
      const at = deps.clock.now();
      await deps.insertExperiment({
        id,
        hypothesisId,
        treatment: parsed.treatment,
        controlBaseline: parsed.controlBaseline,
        successCriteria: parsed.successCriteria,
        stoppingCriteria: parsed.stoppingCriteria,
        startConditions: parsed.startConditions ?? null,
        plannedDuration: parsed.plannedDuration ?? null,
        sampleCoverageConstraints: parsed.sampleCoverageConstraints ?? null,
        budgetEstimate: parsed.budgetEstimate ?? null,
        responsible: parsed.responsible,
        createdVia: ctx.createdVia,
        at,
      });
      const row = await deps.getExperimentById(id);
      if (!row) throw new DomainError({ code: "EXPERIMENT_NOT_FOUND", message: "Experiment not found immediately after creation", details: { id } });
      return toExperiment(row);
    },

    async getExperiment(experimentId: string, ctx: { userId: string | null | undefined }): Promise<Experiment> {
      const { experiment } = await assertExperimentAccessible(experimentId, ctx);
      return toExperiment(experiment);
    },

    async listExperimentsByHypothesis(
      hypothesisId: string,
      ctx: { userId: string | null | undefined }
    ): Promise<Experiment[]> {
      await assertHypothesisAccessible(hypothesisId, ctx);
      const rows = await deps.listExperimentsByHypothesis(hypothesisId);
      return rows.map(toExperiment);
    },

    async transitionExperiment(
      experimentId: string,
      input: unknown,
      ctx: { userId: string | null | undefined; actor: string }
    ): Promise<Experiment> {
      const { experiment } = await assertExperimentAccessible(experimentId, ctx);
      const parsed = parseWithSchema(transitionExperimentInputSchema, input, "transition experiment input");
      assertValidStatusTransition(experiment.status, parsed.targetStatus);
      // The atomic DB guard re-checks against the row's REAL status at write time, not this
      // read-time `experiment.status` -- a concurrent transition between this read and the write
      // below is exactly the race `advisor()` flagged; the atomic UPDATE...WHERE below is what
      // actually closes it, this read-time check is only a fast, friendly early rejection.
      const at = deps.clock.now();
      const updated = await deps.transitionExperimentStatusIfValid(
        experimentId,
        [experiment.status],
        parsed.targetStatus,
        parsed.targetStatus === "approved" ? ctx.actor : null,
        at
      );
      if (!updated) {
        const current = await deps.getExperimentById(experimentId);
        throw new DomainError({
          code: "EXPERIMENT_INVALID_TRANSITION",
          message: `Experiment is no longer in a state that allows transitioning to "${parsed.targetStatus}"`,
          details: { experimentId, attemptedTargetStatus: parsed.targetStatus, actualCurrentStatus: current?.status ?? null },
        });
      }
      return toExperiment(updated);
    },

    async createExperimentOutcome(
      experimentId: string,
      input: unknown,
      ctx: { userId: string | null | undefined; recordedBy: string; createdVia: string }
    ): Promise<ExperimentOutcome> {
      const { experiment } = await assertExperimentAccessible(experimentId, ctx);
      if (!EXPERIMENT_OUTCOME_RECORDABLE_STATUSES.includes(experiment.status)) {
        throw new DomainError({
          code: "EXPERIMENT_NOT_OBSERVABLE",
          message: `An outcome cannot be recorded for an experiment in status "${experiment.status}"`,
          details: { experimentId, status: experiment.status },
        });
      }
      const parsed = parseWithSchema(createExperimentOutcomeInputSchema, input, "create experiment outcome input");
      const id = deps.idGenerator();
      const at = deps.clock.now();
      await deps.insertExperimentOutcome({
        id,
        experimentId,
        recordedBy: ctx.recordedBy,
        outcomeData: parsed.outcomeData,
        dataQualityLimitations: parsed.dataQualityLimitations ?? null,
        criteriaMet: parsed.criteriaMet,
        lessonsLearned: parsed.lessonsLearned ?? null,
        createdVia: ctx.createdVia,
        at,
      });
      const rows = await deps.listExperimentOutcomesByExperiment(experimentId);
      const row = rows.find((r) => r.id === id);
      if (!row) throw new DomainError({ code: "EXPERIMENT_NOT_FOUND", message: "Outcome not found immediately after creation", details: { id } });
      return toExperimentOutcome(row);
    },

    async listExperimentOutcomes(
      experimentId: string,
      ctx: { userId: string | null | undefined }
    ): Promise<ExperimentOutcome[]> {
      await assertExperimentAccessible(experimentId, ctx);
      const rows = await deps.listExperimentOutcomesByExperiment(experimentId);
      return rows.map(toExperimentOutcome);
    },

    /**
     * Phase 10 slice 2 (docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md) -- one hypothesis plus every
     * one of its experiments, each with its own outcomes, in one call (mirrors
     * market-intelligence's own `getWatchlistEntryContext` shape). Does ONE access check
     * (`assertHypothesisAccessible`), then reads experiments/outcomes directly from the store --
     * not `listExperimentsByHypothesis`/`listExperimentOutcomes` above, which would each re-run
     * `assertExperimentAccessible` -> `assertHypothesisAccessible` per experiment (found by
     * advisor review: real, avoidable duplication once a single caller already knows the
     * hypothesis is accessible).
     */
    async getHypothesisTrail(
      hypothesisId: string,
      ctx: { userId: string | null | undefined }
    ): Promise<{
      hypothesis: Hypothesis;
      experiments: (Experiment & { outcomes: ExperimentOutcome[] })[];
      evidence: HypothesisEvidence[];
    }> {
      const hypothesisRow = await assertHypothesisAccessible(hypothesisId, ctx);
      const experimentRows = await deps.listExperimentsByHypothesis(hypothesisId);
      const experiments = await Promise.all(
        experimentRows.map(async (experimentRow) => ({
          ...toExperiment(experimentRow),
          outcomes: (await deps.listExperimentOutcomesByExperiment(experimentRow.id)).map(toExperimentOutcome),
        }))
      );
      const evidence = (await deps.listHypothesisEvidenceByHypothesis(hypothesisId)).map(toHypothesisEvidence);
      return { hypothesis: toHypothesis(hypothesisRow), experiments, evidence };
    },

    /**
     * Phase 10 slice 3 (docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md) -- `resolver` is supplied by
     * the CALLER (the route file), never constructed here: this module must never import
     * `@/lib/analytics`/`@/lib/market-intelligence` (`AGENTS.md` §M, contracts.ts's own block
     * comment has the full rationale). The reference is validated (does it actually exist, and is
     * the caller actually authorized for it) BEFORE the insert -- a failed resolve throws
     * `validation_failed` and nothing is written.
     */
    async addHypothesisEvidence(
      hypothesisId: string,
      input: unknown,
      ctx: { userId: string | null | undefined; createdVia: string },
      resolver: EvidenceReferenceResolver
    ): Promise<HypothesisEvidence> {
      const hypothesisRow = await assertHypothesisAccessible(hypothesisId, ctx);
      const parsed = parseWithSchema(addHypothesisEvidenceInputSchema, input, "add hypothesis evidence input");

      if (
        parsed.reference.sourceType === "phase8_metric" &&
        hypothesisRow.channelId !== null &&
        parsed.reference.channelId !== hypothesisRow.channelId
      ) {
        throw new DomainError({
          code: "validation_failed",
          message: "A phase8_metric reference's channelId must match the hypothesis's own channelId",
          details: { hypothesisChannelId: hypothesisRow.channelId, referenceChannelId: parsed.reference.channelId },
        });
      }

      const resolved = await resolver.resolve(parsed.reference, ctx);
      if (!resolved) {
        throw new DomainError({
          code: "validation_failed",
          message: "The referenced Phase 8/9 row does not exist",
          details: { reference: parsed.reference },
        });
      }

      const id = deps.idGenerator();
      const at = deps.clock.now();
      await deps.insertHypothesisEvidence({
        id,
        hypothesisId,
        sourceType: parsed.reference.sourceType,
        referenceJson: JSON.stringify(parsed.reference),
        note: parsed.note ?? null,
        createdVia: ctx.createdVia,
        at,
      });
      const rows = await deps.listHypothesisEvidenceByHypothesis(hypothesisId);
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) {
        throw new DomainError({
          code: "validation_failed",
          message: "Hypothesis evidence not found immediately after creation",
          details: { id },
        });
      }
      return toHypothesisEvidence(row);
    },

    async listHypothesisEvidence(
      hypothesisId: string,
      ctx: { userId: string | null | undefined }
    ): Promise<HypothesisEvidence[]> {
      await assertHypothesisAccessible(hypothesisId, ctx);
      const rows = await deps.listHypothesisEvidenceByHypothesis(hypothesisId);
      return rows.map(toHypothesisEvidence);
    },
  };
}

export type DecisionEngineServices = ReturnType<typeof createDecisionEngineServices>;
