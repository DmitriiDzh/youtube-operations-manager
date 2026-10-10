import {
  DomainError,
  parseWithSchema,
  EXPERIMENT_ARM_LINKABLE_STATUSES,
  EXPERIMENT_EXECUTION_CLAIM_EXPIRY_MS,
  EXPERIMENT_OUTCOME_RECORDABLE_STATUSES,
  MAX_ARM_VIDEOS_PER_EXPERIMENT,
  type ExperimentArm,
  EXPERIMENT_STATUS_TRANSITIONS,
  type EvidenceReference,
  type EvidenceReferenceResolver,
  type Experiment,
  type ExperimentExecutionResolver,
  type ExperimentOutcome,
  type ExperimentStatus,
  type Hypothesis,
  type HypothesisDraftProvider,
  type HypothesisEvidence,
} from "./contracts";
import {
  addHypothesisEvidenceInputSchema,
  createExperimentInputSchema,
  createExperimentOutcomeInputSchema,
  createHypothesisInputSchema,
  executeExperimentInputSchema,
  generateHypothesisDraftInputSchema,
  linkExperimentArmVideoInputSchema,
  saveGeneratedHypothesisInputSchema,
  setExperimentChangeSetInputSchema,
  transitionExperimentInputSchema,
} from "./schemas";
import type {
  HypothesisEvidenceSourceType,
  StoredExperiment,
  StoredExperimentArmVideo,
  StoredExperimentOutcome,
  StoredHypothesis,
  StoredHypothesisEvidence,
  StoredHypothesisGenerationProvenance,
} from "@/lib/db";

type ChannelAccess = {
  assertActiveChannel(args: { userId: string | null | undefined; channelId: string }): Promise<string>;
  getActiveChannelId(userId: string | null | undefined): Promise<string | null>;
};

export type DecisionEngineServiceDependencies = {
  idGenerator(): string;
  clock: { now(): Date };
  channelAccess: ChannelAccess;
  /** Phase 12 (docs/roadmap/plans/PHASE_12_PLAN.md 12.4, AC-P12-09): true inside a channel-bound agent
   * session. Channel-less ("new channel concept") hypotheses are operator-only there -- an agent sees
   * and touches only its own channel's rows. Optional; absent means false (operator semantics). */
  isAgentSession?: () => boolean;
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
    at: Date,
    claimExpiryCutoff: Date,
    requiredChangeSetId?: string | null
  ) => Promise<StoredExperiment | null>;
  /** Phase 10 slice 5. Attach (`changeSetId` set) or detach (`null`), guarded atomically by the
   * caller's own `fromStatuses` (`["proposed", "approved"]` for both directions) and by there
   * being no FRESH execution claim held. */
  setExperimentChangeSetIfEligible: (
    id: string,
    fromStatuses: ExperimentStatus[],
    changeSetId: string | null,
    claimExpiryCutoff: Date
  ) => Promise<StoredExperiment | null>;
  /** Phase 10 slice 5 -- step 2 of `executeExperiment`'s claim-first design. `null` if the claim
   * was not won (already freshly claimed, not approved, or `changeSetId` no longer matches). */
  claimExperimentForExecution: (
    id: string,
    expectedChangeSetId: string,
    at: Date,
    claimExpiryCutoff: Date
  ) => Promise<StoredExperiment | null>;
  /** Phase 10 slice 5 -- releases a claim ONLY when the resolver call after it fails, and ONLY
   * if `expectedClaimedAt` still matches (a stalled/expired caller must never clear a different,
   * newer claim someone else already took). Returns `false` (benign, not an error) if the guard
   * didn't match -- this call's own claim was already superseded. */
  releaseExperimentExecutionClaim: (id: string, expectedClaimedAt: Date) => Promise<boolean>;
  /** Phase 10 slice 5 -- step 5, guarded by the exact claim timestamp; `false` if the guard didn't
   * match (must be treated as a real failure, not assumed success). */
  finalizeExperimentExecution: (id: string, executionBatchId: string, expectedClaimedAt: Date) => Promise<boolean>;
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
  /** Phase 10 slice 4. Optional so every existing test fixture that never exercises generation
   * keeps working unchanged (`AGENTS.md` §D, exact same optionality precedent as
   * `ai-localization/services.ts`'s own `resolveConnectionProvider`). `undefined` connectionId
   * means "use the mock provider" -- resolved by the caller (index.ts), never guessed here. */
  resolveHypothesisDraftProvider?: (connectionId: string | undefined) => Promise<HypothesisDraftProvider>;
  /** RISK-30's own precedent (ai-localization/services.ts) -- a real-connection generation call is
   * a genuine outbound call to an external AI provider, gated the same way. Optional so mock-only
   * fixtures are unaffected; called only when `connectionId` is set. */
  assertDeviceAvailable?(): Promise<void>;
  insertHypothesisGenerationProvenance: (input: {
    id: string;
    hypothesisId: string;
    connectionId?: string | null;
    providerName: string;
    modelId?: string | null;
    generatedStatement: string;
    finalStatement: string;
    rationale?: string | null;
    evidenceRefCount: number;
    editedBeforeSave: boolean;
    at?: Date;
  }) => Promise<void>;
  getHypothesisGenerationProvenanceByHypothesis: (hypothesisId: string) => Promise<StoredHypothesisGenerationProvenance | null>;
  /**
   * BL-170 (docs/roadmap/plans/EXPERIMENT_ARMS_PLAN.md). Optional so the fixtures that never touch arms keep working: without
   * `listExperimentArmVideos` the trail lists no arms; linking needs all four.
   */
  listExperimentArmVideos?: (experimentIds: string[]) => Promise<StoredExperimentArmVideo[]>;
  insertExperimentArmVideoIfEligible?: (
    row: { experimentId: string; videoId: string; arm: string; linkedBy: string; linkedVia: "web_ui" | "producer_proposal"; at: Date },
    fromStatuses: ExperimentStatus[],
    maxVideos: number
  ) => Promise<boolean>;
  deleteExperimentArmVideoIfEligible?: (experimentId: string, videoId: string, fromStatuses: ExperimentStatus[]) => Promise<boolean>;
  /** The ids of the channel's synced videos (any visibility): a linked video must be one of them. */
  listChannelVideoIds?: (channelId: string) => Promise<string[]>;
};

/** BL-170: an experiment's arms, with the hypothesis's channel (null for a new-channel concept). */
export type ExperimentArmsView = { experimentId: string; status: ExperimentStatus; channelId: string | null; arms: ExperimentArm[] };

/** BL-170: arm links grouped by arm -- `control` first, then by label; videos in the order they were linked. */
export function groupExperimentArms(rows: StoredExperimentArmVideo[]): ExperimentArm[] {
  const byArm = new Map<string, StoredExperimentArmVideo[]>();
  for (const row of rows) byArm.set(row.arm, [...(byArm.get(row.arm) ?? []), row]);
  return [...byArm.entries()]
    .sort(([a], [b]) => (a === "control" ? -1 : b === "control" ? 1 : a.localeCompare(b)))
    .map(([arm, videos]) => ({
      arm,
      videos: videos
        .sort((a, b) => a.linkedAt.getTime() - b.linkedAt.getTime() || a.videoId.localeCompare(b.videoId))
        .map((row) => ({ videoId: row.videoId, linkedAt: row.linkedAt.toISOString(), linkedBy: row.linkedBy, linkedVia: row.linkedVia })),
    }));
}

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
    changeSetId: row.changeSetId,
    executionBatchId: row.executionBatchId,
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

function toGenerationProvenance(row: StoredHypothesisGenerationProvenance) {
  return {
    hypothesisId: row.hypothesisId,
    connectionId: row.connectionId,
    providerName: row.providerName,
    modelId: row.modelId,
    generatedStatement: row.generatedStatement,
    finalStatement: row.finalStatement,
    rationale: row.rationale,
    evidenceRefCount: row.evidenceRefCount,
    editedBeforeSave: row.editedBeforeSave,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Shared by `addHypothesisEvidence` and `saveGeneratedHypothesis` -- both must apply the identical
 * channelId-match + real-existence check before an evidence reference is ever persisted (Phase 10
 * slice 4 factored this out of `addHypothesisEvidence`'s own inline body, zero behavior change,
 * proven by that function's own pre-existing tests passing unmodified).
 */
async function assertEvidenceReferenceValid(
  hypothesisRow: { channelId: string | null },
  reference: EvidenceReference,
  ctx: { userId: string | null | undefined },
  resolver: EvidenceReferenceResolver
): Promise<void> {
  if (reference.sourceType === "phase8_metric" && hypothesisRow.channelId !== null && reference.channelId !== hypothesisRow.channelId) {
    throw new DomainError({
      code: "validation_failed",
      message: "A phase8_metric reference's channelId must match the hypothesis's own channelId",
      details: { hypothesisChannelId: hypothesisRow.channelId, referenceChannelId: reference.channelId },
    });
  }
  const resolved = await resolver.resolve(reference, ctx);
  if (!resolved) {
    throw new DomainError({
      code: "validation_failed",
      message: "The referenced Phase 8/9 row does not exist",
      details: { reference },
    });
  }
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
    } else if (deps.isAgentSession?.()) {
      // Same error as a nonexistent id -- an agent cannot even learn a channel-less row exists.
      throw new DomainError({ code: "HYPOTHESIS_NOT_FOUND", message: "Hypothesis not found", details: { hypothesisId } });
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

  function armDeps() {
    const { listExperimentArmVideos, insertExperimentArmVideoIfEligible, deleteExperimentArmVideoIfEligible, listChannelVideoIds } = deps;
    if (!listExperimentArmVideos || !insertExperimentArmVideoIfEligible || !deleteExperimentArmVideoIfEligible || !listChannelVideoIds) {
      throw new Error("Experiment arms are not wired into the decision engine");
    }
    return { listExperimentArmVideos, insertExperimentArmVideoIfEligible, deleteExperimentArmVideoIfEligible, listChannelVideoIds };
  }

  /**
   * BL-170: why a video cannot be linked to this experiment, as a DomainError -- or nothing when it can. The same checks run before the
   * owner's link, for a Producer proposal when it is submitted, and again (atomically, in the insert) when it is written.
   */
  async function assertArmLinkAllowed(experiment: StoredExperiment, hypothesis: StoredHypothesis, videoId: string): Promise<void> {
    const arms = armDeps();
    if (!hypothesis.channelId) {
      throw new DomainError({
        code: "EXPERIMENT_ARM_CHANNEL_REQUIRED",
        message: "This experiment's hypothesis has no channel -- videos can only be linked to a channel-scoped experiment",
        details: { experimentId: experiment.id, hypothesisId: hypothesis.id },
      });
    }
    if (!(EXPERIMENT_ARM_LINKABLE_STATUSES as readonly string[]).includes(experiment.status)) {
      throw new DomainError({
        code: "EXPERIMENT_ARMS_FROZEN",
        message: `The experiment is ${experiment.status}: its videos are its history and can no longer be changed`,
        details: { experimentId: experiment.id, status: experiment.status },
      });
    }
    if (!(await arms.listChannelVideoIds(hypothesis.channelId)).includes(videoId)) {
      throw new DomainError({
        code: "EXPERIMENT_ARM_VIDEO_NOT_FOUND",
        message: "The video is not a synced video of the experiment's channel",
        details: { videoId, channelId: hypothesis.channelId },
      });
    }
    const links = await arms.listExperimentArmVideos([experiment.id]);
    const existing = links.find((link) => link.videoId === videoId);
    if (existing) {
      throw new DomainError({
        code: "EXPERIMENT_ARM_VIDEO_ALREADY_LINKED",
        message: `The video is already in arm "${existing.arm}" of this experiment -- remove it first`,
        details: { videoId, arm: existing.arm },
      });
    }
    if (links.length >= MAX_ARM_VIDEOS_PER_EXPERIMENT) {
      throw new DomainError({
        code: "EXPERIMENT_ARMS_FULL",
        message: `An experiment has at most ${MAX_ARM_VIDEOS_PER_EXPERIMENT} videos`,
        details: { experimentId: experiment.id, max: MAX_ARM_VIDEOS_PER_EXPERIMENT },
      });
    }
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
      const includeChannelless = !deps.isAgentSession?.();
      const filtered = rows.filter((row) => (row.channelId === null ? includeChannelless : row.channelId === activeChannelId));
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
      // Phase 10 slice 5: an experiment with a Change Set attached must reach "running" only
      // through executeExperiment, so "running" always corresponds to a real Batch -- never a bare
      // manual transition. An experiment with no Change Set (any non-localization type, or a
      // localization-type one that never got one attached) is unaffected, exactly slice 1's shipped
      // behavior.
      if (parsed.targetStatus === "running" && experiment.changeSetId !== null) {
        throw new DomainError({
          code: "EXPERIMENT_MUST_USE_EXECUTE",
          message: "This experiment has a Change Set attached -- use the Execute action, not a manual status transition",
          details: { experimentId, changeSetId: experiment.changeSetId },
        });
      }
      assertValidStatusTransition(experiment.status, parsed.targetStatus);
      // The atomic DB guard re-checks against the row's REAL status at write time, not this
      // read-time `experiment.status` -- a concurrent transition between this read and the write
      // below is exactly the race `advisor()` flagged; the atomic UPDATE...WHERE below is what
      // actually closes it, this read-time check is only a fast, friendly early rejection.
      const at = deps.clock.now();
      const claimExpiryCutoff = new Date(at.getTime() - EXPERIMENT_EXECUTION_CLAIM_EXPIRY_MS);
      const updated = await deps.transitionExperimentStatusIfValid(
        experimentId,
        [experiment.status],
        parsed.targetStatus,
        parsed.targetStatus === "approved" ? ctx.actor : null,
        at,
        claimExpiryCutoff,
        // Re-verified atomically at write time, not just via the read-time check above -- a
        // concurrent setExperimentChangeSet attach landing in between could otherwise slip a
        // Change Set onto the row between this function's own read and this write (found by
        // independent review of the whole phase; the read-time check alone only closes the race
        // when the request that reads first also writes first).
        parsed.targetStatus === "running" ? null : undefined
      );
      if (!updated) {
        const current = await deps.getExperimentById(experimentId);
        if (parsed.targetStatus === "running" && current?.changeSetId != null) {
          throw new DomainError({
            code: "EXPERIMENT_MUST_USE_EXECUTE",
            message: "This experiment has a Change Set attached -- use the Execute action, not a manual status transition",
            details: { experimentId, changeSetId: current.changeSetId },
          });
        }
        throw new DomainError({
          code: "EXPERIMENT_INVALID_TRANSITION",
          message: `Experiment is no longer in a state that allows transitioning to "${parsed.targetStatus}"`,
          details: { experimentId, attemptedTargetStatus: parsed.targetStatus, actualCurrentStatus: current?.status ?? null },
        });
      }
      return toExperiment(updated);
    },

    /** Phase 10 slice 5. Attach (`changeSetId` set, validated via `resolver`) or detach (`null`,
     * no resolver call needed) -- both restricted to `["proposed", "approved"]` so a
     * `running`/`concluded`/`abandoned` experiment's Change Set link is immutable. */
    async setExperimentChangeSet(
      experimentId: string,
      input: unknown,
      ctx: { userId: string | null | undefined },
      resolver: ExperimentExecutionResolver
    ): Promise<Experiment> {
      const { hypothesis } = await assertExperimentAccessible(experimentId, ctx);
      const parsed = parseWithSchema(setExperimentChangeSetInputSchema, input, "set experiment change set input");

      if (parsed.changeSetId !== null) {
        if (!hypothesis.channelId) {
          throw new DomainError({
            code: "EXPERIMENT_CHANGE_SET_CHANNEL_MISMATCH",
            message: "This experiment's hypothesis has no channel -- a Change Set can only be attached to a channel-scoped experiment",
            details: { experimentId, hypothesisId: hypothesis.id },
          });
        }
        const belongs = await resolver.verifyChangeSetBelongsToChannel(parsed.changeSetId, hypothesis.channelId);
        if (!belongs) {
          throw new DomainError({
            code: "EXPERIMENT_CHANGE_SET_NOT_FOUND",
            message: `Change Set ${parsed.changeSetId} does not exist for this experiment's channel`,
            details: { changeSetId: parsed.changeSetId, channelId: hypothesis.channelId },
          });
        }
      }

      const setAt = deps.clock.now();
      const claimExpiryCutoff = new Date(setAt.getTime() - EXPERIMENT_EXECUTION_CLAIM_EXPIRY_MS);
      const updated = await deps.setExperimentChangeSetIfEligible(experimentId, ["proposed", "approved"], parsed.changeSetId, claimExpiryCutoff);
      if (!updated) {
        const current = await deps.getExperimentById(experimentId);
        throw new DomainError({
          code: "EXPERIMENT_INVALID_TRANSITION",
          message: `Experiment is no longer in a state that allows changing its Change Set (status "${current?.status ?? "unknown"}", or a fresh execution claim is held)`,
          details: { experimentId, actualCurrentStatus: current?.status ?? null },
        });
      }
      return toExperiment(updated);
    },

    /** Phase 10 slice 5 -- claim-first execution (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md §4),
     * redesigned after `advisor()` caught a real double-execution race in an earlier draft that
     * called the resolver BEFORE any atomic guard. */
    async executeExperiment(
      experimentId: string,
      input: unknown,
      ctx: { userId: string | null | undefined },
      resolver: ExperimentExecutionResolver,
      liveWritesEnabled: boolean
    ): Promise<{ experiment: Experiment; batchId: string; videoCount: number; dryRun: boolean }> {
      const { experiment, hypothesis } = await assertExperimentAccessible(experimentId, ctx);
      const parsed = parseWithSchema(executeExperimentInputSchema, input, "execute experiment input");

      // Step 1: fast, friendly early rejection -- not the real guard (step 2 is).
      if (experiment.status !== "approved" || experiment.changeSetId === null) {
        throw new DomainError({
          code: "EXPERIMENT_NOT_EXECUTABLE",
          message: 'Only an "approved" experiment with a Change Set attached can be executed',
          details: { experimentId, status: experiment.status, changeSetId: experiment.changeSetId },
        });
      }
      const changeSetId = experiment.changeSetId;
      // Fail-closed, identical to the existing Batch-creation route's own gate (AGENTS.md §G): a
      // request body cannot force a live write while the global Live Writes toggle is off.
      const dryRun = liveWritesEnabled ? !(parsed.live ?? false) : true;

      // Step 2: atomic claim -- exclusive against another FRESH claim, so at most one concurrent
      // call ever reaches step 3/4 for the same experiment; a stale/expired claim (a crashed prior
      // attempt) can still be reclaimed.
      const at = deps.clock.now();
      const claimExpiryCutoff = new Date(at.getTime() - EXPERIMENT_EXECUTION_CLAIM_EXPIRY_MS);
      const claimed = await deps.claimExperimentForExecution(experimentId, changeSetId, at, claimExpiryCutoff);
      if (!claimed) {
        const current = await deps.getExperimentById(experimentId);
        throw new DomainError({
          code: "EXPERIMENT_INVALID_TRANSITION",
          message: "Experiment is no longer in a state that allows execution (already claimed, or its state changed)",
          details: { experimentId, actualCurrentStatus: current?.status ?? null, actualChangeSetId: current?.changeSetId ?? null },
        });
      }

      let batchId: string;
      let videoCount: number;
      try {
        // `channelId` is guaranteed non-null here: `setExperimentChangeSet` never persists a
        // non-null `changeSetId` unless `hypothesis.channelId` is also non-null, and step 1 above
        // already confirmed `experiment.changeSetId !== null` -- asserted explicitly rather than
        // silently cast, so a future change to that invariant fails loudly here instead of
        // type-casting around a real bug.
        const channelId = hypothesis.channelId;
        if (!channelId) {
          throw new DomainError({
            code: "EXPERIMENT_CHANGE_SET_CHANNEL_MISMATCH",
            message: "This experiment's hypothesis has no channel -- cannot execute",
            details: { experimentId },
          });
        }

        // Create the real Batch (formerly "step 4" -- the former "step 3", a separate
        // `verifyChangeSetBelongsToChannel` re-check, was removed after independent review of the
        // whole phase: `createDryRunBatch` below already calls the real `getChangeSet` scoped to
        // this exact `channelId`, so it
        // independently re-verifies channel ownership on its own (a wrong/stale `changeSetId`
        // surfaces as that call's own `not_found` DomainError) -- the former step 3 paid an
        // identical extra DB round-trip on every real execute for a guarantee step 4 already
        // provides, "re-run the full safety pipeline immediately before send" (AC-BATCH-03) is
        // still satisfied by this single real check, not lost by removing the duplicate of it.
        const created = await resolver.createDryRunBatch({ channelId, changeSetId, dryRun });
        batchId = created.batchId;
        videoCount = created.videoCount;
      } catch (error) {
        // Release the claim ONLY here -- the Batch was never created, so returning to a normal,
        // re-attemptable "approved" state is exactly correct (status itself was never touched by
        // the claim). Guarded by `at` (this call's own claim timestamp) -- if this call stalled
        // long enough for the claim to expire and a second caller already reclaimed it, this
        // release is a benign no-op, never a release of that second caller's own fresh claim.
        await deps.releaseExperimentExecutionClaim(experimentId, at);
        throw error;
      }

      // Step 5: finalize -- deliberately OUTSIDE the try/catch above (`advisor()` review, round 2:
      // the earlier version released the claim on ANY failure including finalize's own, which
      // would let a second call re-create a second real Batch for a Batch that already exists). A
      // finalize failure here leaves the claim held -- self-healing via `claimExpiryCutoff` above,
      // never silently duplicating a Batch. `false` means the guard didn't match (the claim/status
      // moved between step 2 and here, which should be impossible given the claim's own
      // exclusivity, but is treated as a real, loud failure rather than assumed success).
      const finalized = await deps.finalizeExperimentExecution(experimentId, batchId, at);
      if (!finalized) {
        throw new DomainError({
          code: "EXPERIMENT_INVALID_TRANSITION",
          message: "A real Batch was created but the experiment's own state could not be finalized -- this needs manual investigation",
          details: { experimentId, batchId },
        });
      }
      const updated = await deps.getExperimentById(experimentId);
      return { experiment: toExperiment(updated as StoredExperiment), batchId, videoCount, dryRun };
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
      // BL-170: each experiment's videos by arm (none when arms are not wired).
      const armRows = deps.listExperimentArmVideos ? await deps.listExperimentArmVideos(experimentRows.map((row) => row.id)) : [];
      return {
        hypothesis: toHypothesis(hypothesisRow),
        experiments: experiments.map((experiment) => ({
          ...experiment,
          arms: groupExperimentArms(armRows.filter((row) => row.experimentId === experiment.experimentId)),
        })),
        evidence,
      };
    },

    /** BL-170: the experiment's videos by arm. Channel-scoped like every experiment read. */
    async listExperimentArms(experimentId: string, ctx: { userId: string | null | undefined }): Promise<ExperimentArmsView> {
      const { experiment, hypothesis } = await assertExperimentAccessible(experimentId, ctx);
      return { experimentId, status: experiment.status, channelId: hypothesis.channelId, arms: groupExperimentArms(await armDeps().listExperimentArmVideos([experimentId])) };
    },

    /**
     * BL-170: links a video of the experiment's channel to an arm. Web UI (the owner) and an approved Producer proposal only -- never an
     * agent tool (PHASE10-INV-02). Allowed while the experiment is proposed/approved/running, for a video not linked yet, up to
     * MAX_ARM_VIDEOS_PER_EXPERIMENT; the insert re-checks all of it atomically.
     */
    async linkExperimentArmVideo(
      experimentId: string,
      input: unknown,
      ctx: { userId: string | null | undefined; linkedBy: string; linkedVia: "web_ui" | "producer_proposal" }
    ): Promise<ExperimentArmsView> {
      const { experiment, hypothesis } = await assertExperimentAccessible(experimentId, ctx);
      const parsed = parseWithSchema(linkExperimentArmVideoInputSchema, input, "link experiment arm video input");
      await assertArmLinkAllowed(experiment, hypothesis, parsed.videoId);
      const arms = armDeps();
      const inserted = await arms.insertExperimentArmVideoIfEligible(
        { experimentId, videoId: parsed.videoId, arm: parsed.arm, linkedBy: ctx.linkedBy, linkedVia: ctx.linkedVia, at: deps.clock.now() },
        [...EXPERIMENT_ARM_LINKABLE_STATUSES],
        MAX_ARM_VIDEOS_PER_EXPERIMENT
      );
      if (!inserted) {
        // Something changed between the checks and the insert: say what, from the current state.
        const current = await deps.getExperimentById(experimentId);
        if (current) await assertArmLinkAllowed(current, hypothesis, parsed.videoId);
        throw new DomainError({ code: "EXPERIMENT_INVALID_TRANSITION", message: "The experiment changed meanwhile; try again", details: { experimentId } });
      }
      return { experimentId, status: experiment.status, channelId: hypothesis.channelId, arms: groupExperimentArms(await arms.listExperimentArmVideos([experimentId])) };
    },

    /** BL-170: removes a video from the experiment's arms, while the experiment is proposed/approved/running. Web UI only. */
    async unlinkExperimentArmVideo(
      experimentId: string,
      videoId: string,
      ctx: { userId: string | null | undefined }
    ): Promise<ExperimentArmsView> {
      const { experiment, hypothesis } = await assertExperimentAccessible(experimentId, ctx);
      const arms = armDeps();
      const links = await arms.listExperimentArmVideos([experimentId]);
      if (!links.some((link) => link.videoId === videoId)) {
        throw new DomainError({ code: "EXPERIMENT_ARM_VIDEO_NOT_LINKED", message: "The video is not linked to this experiment", details: { experimentId, videoId } });
      }
      const frozen = (status: ExperimentStatus) =>
        new DomainError({
          code: "EXPERIMENT_ARMS_FROZEN",
          message: `The experiment is ${status}: its videos are its history and can no longer be changed`,
          details: { experimentId, status },
        });
      if (!(EXPERIMENT_ARM_LINKABLE_STATUSES as readonly string[]).includes(experiment.status)) throw frozen(experiment.status);
      if (!(await arms.deleteExperimentArmVideoIfEligible(experimentId, videoId, [...EXPERIMENT_ARM_LINKABLE_STATUSES]))) {
        const current = await deps.getExperimentById(experimentId);
        if (current && !(EXPERIMENT_ARM_LINKABLE_STATUSES as readonly string[]).includes(current.status)) throw frozen(current.status);
        throw new DomainError({ code: "EXPERIMENT_ARM_VIDEO_NOT_LINKED", message: "The video is not linked to this experiment", details: { experimentId, videoId } });
      }
      return { experimentId, status: experiment.status, channelId: hypothesis.channelId, arms: groupExperimentArms(await arms.listExperimentArmVideos([experimentId])) };
    },

    /**
     * BL-170: each experiment's treatment, for the owner's proposal cards in Research → Inbox (the owner's own view across channels, so
     * no active-channel check; it reads one field). Unknown ids are left out.
     */
    async describeExperiments(experimentIds: string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      for (const id of new Set(experimentIds)) {
        const experiment = await deps.getExperimentById(id);
        if (experiment) out.set(id, experiment.treatment);
      }
      return out;
    },

    /**
     * BL-170: the submit-time check of a Producer `experiment.link_video` proposal for `channelId`. The Producer is not in that channel's
     * scope when it proposes (BL-163), so the channel is compared with the hypothesis's own instead of the owner's active channel; an
     * experiment of another channel is reported as not found. Writes nothing; approving goes through `linkExperimentArmVideo`.
     */
    async checkExperimentArmVideoProposal(input: { channelId: string; experimentId: string; videoId: string; arm: string }): Promise<void> {
      const experiment = await deps.getExperimentById(input.experimentId);
      const hypothesis = experiment ? await deps.getHypothesisById(experiment.hypothesisId) : null;
      if (!experiment || !hypothesis || hypothesis.channelId !== input.channelId) {
        throw new DomainError({ code: "EXPERIMENT_NOT_FOUND", message: "Experiment not found", details: { experimentId: input.experimentId } });
      }
      parseWithSchema(linkExperimentArmVideoInputSchema, { videoId: input.videoId, arm: input.arm }, "link experiment arm video input");
      await assertArmLinkAllowed(experiment, hypothesis, input.videoId);
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

      await assertEvidenceReferenceValid(hypothesisRow, parsed.reference, ctx, resolver);

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

    /**
     * Phase 10 slice 4 -- generates a DRAFT only, persists nothing (mirrors `ai-localization`'s
     * `generateProposals`' own "preview only" contract). `evidenceReferences` are references the
     * OPERATOR already selected (e.g. from browsing a channel's Phase 8/9 data elsewhere in the
     * UI) -- validated exactly like a manual attach BEFORE their summaries are sent to the model,
     * so the model only ever sees text describing real, already-verified evidence, never a raw row
     * and never something it could fabricate a reference for.
     */
    async generateHypothesisDraft(
      input: unknown,
      ctx: { userId: string | null | undefined },
      resolver: EvidenceReferenceResolver
    ): Promise<{
      statement: string;
      rationale: string;
      providerName: string;
      connectionId: string | null;
      evidenceReferences: EvidenceReference[];
    }> {
      const parsed = parseWithSchema(generateHypothesisDraftInputSchema, input, "generate hypothesis draft input");
      if (parsed.channelId) {
        await deps.channelAccess.assertActiveChannel({ userId: ctx.userId, channelId: parsed.channelId });
      }

      const evidenceSummaries: string[] = [];
      for (const reference of parsed.evidenceReferences) {
        await assertEvidenceReferenceValid({ channelId: parsed.channelId ?? null }, reference, ctx, resolver);
        evidenceSummaries.push(await resolver.describe(reference, ctx));
      }

      if (!deps.resolveHypothesisDraftProvider) {
        throw new DomainError({ code: "provider_not_configured", message: "AI generation is not wired into this service instance" });
      }
      // RISK-30's own precedent: a real-connection call is a genuine outbound call to an external
      // AI provider, gated the same way generateProposals already gates its own real-connection path.
      if (parsed.connectionId && deps.assertDeviceAvailable) await deps.assertDeviceAvailable();
      const provider = await deps.resolveHypothesisDraftProvider(parsed.connectionId);

      const outcome = await provider.generateHypothesis({
        channelId: parsed.channelId ?? null,
        notes: parsed.notes,
        evidenceSummaries,
      });

      if (outcome.status === "error") {
        throw new DomainError({ code: "generation_failed", message: outcome.message, details: { provider: provider.name } });
      }

      return {
        statement: outcome.statement,
        rationale: outcome.rationale,
        providerName: provider.name,
        connectionId: parsed.connectionId ?? null,
        evidenceReferences: parsed.evidenceReferences,
      };
    },

    /**
     * Persists a (possibly human-edited) AI-generated draft -- mirrors `createChangeSetFromProposals`'s
     * own "the caller re-submits the reviewed values, this action re-validates and persists them"
     * shape (`AGENTS.md` §D), never a server-held draft the client references by id. Three writes,
     * in order: the hypothesis itself (via the same `insertHypothesis` `createHypothesis` uses),
     * each evidence reference (re-validated here, never trusted from generation time -- state may
     * have changed since), and one provenance row recording AI authorship.
     */
    async saveGeneratedHypothesis(
      input: unknown,
      ctx: { userId: string | null | undefined; createdBy: string; createdVia: string },
      resolver: EvidenceReferenceResolver
    ): Promise<Hypothesis> {
      const parsed = parseWithSchema(saveGeneratedHypothesisInputSchema, input, "save generated hypothesis input");
      if (parsed.channelId) {
        await deps.channelAccess.assertActiveChannel({ userId: ctx.userId, channelId: parsed.channelId });
      }

      for (const reference of parsed.evidenceReferences) {
        await assertEvidenceReferenceValid({ channelId: parsed.channelId ?? null }, reference, ctx, resolver);
      }

      const hypothesisId = deps.idGenerator();
      const at = deps.clock.now();
      await deps.insertHypothesis({
        id: hypothesisId,
        channelId: parsed.channelId ?? null,
        statement: parsed.finalStatement,
        evidenceNotes: parsed.evidenceNotes,
        createdBy: ctx.createdBy,
        createdVia: ctx.createdVia,
        at,
      });

      for (const reference of parsed.evidenceReferences) {
        await deps.insertHypothesisEvidence({
          id: deps.idGenerator(),
          hypothesisId,
          sourceType: reference.sourceType,
          referenceJson: JSON.stringify(reference),
          createdVia: ctx.createdVia,
          at,
        });
      }

      await deps.insertHypothesisGenerationProvenance({
        id: deps.idGenerator(),
        hypothesisId,
        connectionId: parsed.connectionId ?? null,
        providerName: parsed.providerName,
        modelId: parsed.modelId ?? null,
        generatedStatement: parsed.generatedStatement,
        finalStatement: parsed.finalStatement,
        rationale: parsed.rationale ?? null,
        evidenceRefCount: parsed.evidenceReferences.length,
        editedBeforeSave: parsed.finalStatement !== parsed.generatedStatement,
        at,
      });

      const row = await deps.getHypothesisById(hypothesisId);
      if (!row) {
        throw new DomainError({
          code: "HYPOTHESIS_NOT_FOUND",
          message: "Hypothesis not found immediately after creation",
          details: { id: hypothesisId },
        });
      }
      return toHypothesis(row);
    },

    async getHypothesisGenerationProvenance(hypothesisId: string, ctx: { userId: string | null | undefined }) {
      await assertHypothesisAccessible(hypothesisId, ctx);
      const row = await deps.getHypothesisGenerationProvenanceByHypothesis(hypothesisId);
      return row ? toGenerationProvenance(row) : null;
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
