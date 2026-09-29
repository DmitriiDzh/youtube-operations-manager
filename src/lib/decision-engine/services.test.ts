// ---------------------------------------------------------------------------
// Acceptance criteria derived from FUTURE_PHASES.md §6 + docs/roadmap/plans/PHASE_10_PLAN.md §7,
// refined by docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md §8 (AGENTS.md §L -- written from the
// requirement, not copied from a draft implementation's own output):
//
// AC-10-01: creating an experiment without success_criteria or stopping_criteria is rejected.
// AC-10-02: no code path inserts an outcome row as a side effect of create/transition.
// AC-10-03: assertValidStatusTransition rejects every transition not in the table, exhaustively
//           over all 5x5 from/to pairs.
// AC-10-04: approved_by/approved_at are null immediately after create, set only after a real
//           transition into "approved".
// AC-10-05: a hypothesis scoped to a channel the session isn't authorized for is rejected with
//           CHANNEL_NOT_ACTIVE, on every route shape (create, get, list, and via experiments).
// AC-10-06: a channel-less hypothesis succeeds with zero channel-access checks attempted.
// AC-10-07: recording an outcome against proposed/approved is rejected
//           (EXPERIMENT_NOT_OBSERVABLE); against running/concluded/abandoned it succeeds.
// AC-10-08: a concurrent second transition from a now-stale expected "from" state fails and
//           leaves the row's real status/approved_by untouched by the losing call.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPERIMENT_STATUSES,
  type ExperimentStatus,
} from "./contracts";
import { assertValidStatusTransition, createDecisionEngineServices } from "./services";
import { DomainError, isDomainError } from "./contracts";

type HypothesisRow = {
  id: string;
  channelId: string | null;
  statement: string;
  evidenceNotes: string;
  createdBy: string;
  createdVia: string;
  createdAt: Date;
};

type ExperimentRow = {
  id: string;
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
  approvedAt: Date | null;
  createdVia: string;
  createdAt: Date;
};

type EvidenceRow = {
  id: string;
  hypothesisId: string;
  sourceType: "phase8_metric" | "phase9_channel_snapshot" | "phase9_video_snapshot" | "phase9_trend_candidate";
  referenceJson: string;
  note: string | null;
  createdVia: string;
  createdAt: Date;
};

type OutcomeRow = {
  id: string;
  experimentId: string;
  recordedBy: string;
  recordedAt: Date;
  outcomeData: string;
  dataQualityLimitations: string | null;
  criteriaMet: "met" | "not_met" | "inconclusive";
  lessonsLearned: string | null;
  createdVia: string;
};

function createFakeStore() {
  const hypothesesById = new Map<string, HypothesisRow>();
  const experimentsById = new Map<string, ExperimentRow>();
  const outcomesById = new Map<string, OutcomeRow>();
  const evidenceById = new Map<string, EvidenceRow>();
  const provenanceByHypothesisId = new Map<
    string,
    {
      id: string;
      hypothesisId: string;
      connectionId: string | null;
      providerName: string;
      modelId: string | null;
      generatedStatement: string;
      finalStatement: string;
      rationale: string | null;
      evidenceRefCount: number;
      editedBeforeSave: boolean;
      createdAt: Date;
    }
  >();
  let nextId = 0;

  return {
    idGenerator: () => `id-${++nextId}`,
    hypothesesById,
    experimentsById,
    outcomesById,
    async insertHypothesis(input: {
      id: string;
      channelId?: string | null;
      statement: string;
      evidenceNotes: string;
      createdBy: string;
      createdVia: string;
      at?: Date;
    }) {
      hypothesesById.set(input.id, {
        id: input.id,
        channelId: input.channelId ?? null,
        statement: input.statement,
        evidenceNotes: input.evidenceNotes,
        createdBy: input.createdBy,
        createdVia: input.createdVia,
        createdAt: input.at ?? new Date(),
      });
    },
    async getHypothesisById(id: string) {
      return hypothesesById.get(id) ?? null;
    },
    async listHypotheses() {
      return [...hypothesesById.values()];
    },
    async insertExperiment(input: {
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
    }) {
      experimentsById.set(input.id, {
        id: input.id,
        hypothesisId: input.hypothesisId,
        treatment: input.treatment,
        controlBaseline: input.controlBaseline,
        successCriteria: input.successCriteria,
        stoppingCriteria: input.stoppingCriteria,
        startConditions: input.startConditions ?? null,
        plannedDuration: input.plannedDuration ?? null,
        sampleCoverageConstraints: input.sampleCoverageConstraints ?? null,
        budgetEstimate: input.budgetEstimate ?? null,
        responsible: input.responsible,
        status: "proposed",
        approvedBy: null,
        approvedAt: null,
        createdVia: input.createdVia,
        createdAt: input.at ?? new Date(),
      });
    },
    async getExperimentById(id: string) {
      return experimentsById.get(id) ?? null;
    },
    async listExperimentsByHypothesis(hypothesisId: string) {
      return [...experimentsById.values()].filter((r) => r.hypothesisId === hypothesisId);
    },
    async transitionExperimentStatusIfValid(
      id: string,
      fromStatuses: ExperimentStatus[],
      toStatus: ExperimentStatus,
      approvedBy: string | null,
      at: Date
    ) {
      const row = experimentsById.get(id);
      if (!row || !fromStatuses.includes(row.status)) return null;
      const updated: ExperimentRow = {
        ...row,
        status: toStatus,
        ...(toStatus === "approved" ? { approvedBy, approvedAt: at } : {}),
      };
      experimentsById.set(id, updated);
      return updated;
    },
    async insertExperimentOutcome(input: {
      id: string;
      experimentId: string;
      recordedBy: string;
      outcomeData: string;
      dataQualityLimitations?: string | null;
      criteriaMet: "met" | "not_met" | "inconclusive";
      lessonsLearned?: string | null;
      createdVia: string;
      at?: Date;
    }) {
      outcomesById.set(input.id, {
        id: input.id,
        experimentId: input.experimentId,
        recordedBy: input.recordedBy,
        recordedAt: input.at ?? new Date(),
        outcomeData: input.outcomeData,
        dataQualityLimitations: input.dataQualityLimitations ?? null,
        criteriaMet: input.criteriaMet,
        lessonsLearned: input.lessonsLearned ?? null,
        createdVia: input.createdVia,
      });
    },
    async listExperimentOutcomesByExperiment(experimentId: string) {
      return [...outcomesById.values()].filter((r) => r.experimentId === experimentId);
    },
    async insertHypothesisEvidence(input: {
      id: string;
      hypothesisId: string;
      sourceType: EvidenceRow["sourceType"];
      referenceJson: string;
      note?: string | null;
      createdVia: string;
      at?: Date;
    }) {
      evidenceById.set(input.id, {
        id: input.id,
        hypothesisId: input.hypothesisId,
        sourceType: input.sourceType,
        referenceJson: input.referenceJson,
        note: input.note ?? null,
        createdVia: input.createdVia,
        createdAt: input.at ?? new Date(),
      });
    },
    async listHypothesisEvidenceByHypothesis(hypothesisId: string) {
      return [...evidenceById.values()].filter((r) => r.hypothesisId === hypothesisId);
    },
    async insertHypothesisGenerationProvenance(input: {
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
    }) {
      provenanceByHypothesisId.set(input.hypothesisId, {
        id: input.id,
        hypothesisId: input.hypothesisId,
        connectionId: input.connectionId ?? null,
        providerName: input.providerName,
        modelId: input.modelId ?? null,
        generatedStatement: input.generatedStatement,
        finalStatement: input.finalStatement,
        rationale: input.rationale ?? null,
        evidenceRefCount: input.evidenceRefCount,
        editedBeforeSave: input.editedBeforeSave,
        createdAt: input.at ?? new Date(),
      });
    },
    async getHypothesisGenerationProvenanceByHypothesis(hypothesisId: string) {
      return provenanceByHypothesisId.get(hypothesisId) ?? null;
    },
  };
}

function createFakeChannelAccess(activeChannelId: string | null, calls: string[]) {
  return {
    async getActiveChannelId() {
      return activeChannelId;
    },
    async assertActiveChannel(args: { userId: string | null | undefined; channelId: string }) {
      calls.push(args.channelId);
      if (args.channelId !== activeChannelId) {
        throw new DomainError({
          code: "CHANNEL_NOT_ACTIVE",
          message: "not active",
          details: { channelId: args.channelId, activeChannelId },
        });
      }
      return activeChannelId;
    },
  };
}

function createServices(activeChannelId: string | null, calls: string[] = []) {
  const store = createFakeStore();
  const services = createDecisionEngineServices({
    idGenerator: store.idGenerator,
    clock: { now: () => new Date("2026-09-29T12:00:00Z") },
    channelAccess: createFakeChannelAccess(activeChannelId, calls),
    insertHypothesis: store.insertHypothesis,
    getHypothesisById: store.getHypothesisById,
    listHypotheses: store.listHypotheses,
    insertExperiment: store.insertExperiment,
    getExperimentById: store.getExperimentById,
    listExperimentsByHypothesis: store.listExperimentsByHypothesis,
    transitionExperimentStatusIfValid: store.transitionExperimentStatusIfValid,
    insertExperimentOutcome: store.insertExperimentOutcome,
    listExperimentOutcomesByExperiment: store.listExperimentOutcomesByExperiment,
    insertHypothesisEvidence: store.insertHypothesisEvidence,
    listHypothesisEvidenceByHypothesis: store.listHypothesisEvidenceByHypothesis,
    insertHypothesisGenerationProvenance: store.insertHypothesisGenerationProvenance,
    getHypothesisGenerationProvenanceByHypothesis: store.getHypothesisGenerationProvenanceByHypothesis,
  });
  return { services, store };
}

const VALID_EXPERIMENT_INPUT = {
  treatment: "Shorter titles",
  controlBaseline: "Current title style",
  successCriteria: "CTR improves by 10%",
  stoppingCriteria: "Stop after 14 days or a 20% CTR regression",
  responsible: "operator",
};

// AC-10-03
test("AC-10-03: assertValidStatusTransition -- exhaustive 5x5 table, hand-derived from the requirement", () => {
  const valid: Record<ExperimentStatus, ExperimentStatus[]> = {
    proposed: ["approved", "abandoned"],
    approved: ["running", "abandoned"],
    running: ["concluded", "abandoned"],
    concluded: [],
    abandoned: [],
  };
  for (const from of EXPERIMENT_STATUSES) {
    for (const to of EXPERIMENT_STATUSES) {
      const shouldBeValid = valid[from].includes(to);
      if (shouldBeValid) {
        assert.doesNotThrow(() => assertValidStatusTransition(from, to), `${from} -> ${to} must be valid`);
      } else {
        assert.throws(
          () => assertValidStatusTransition(from, to),
          (error: unknown) => isDomainError(error) && error.code === "EXPERIMENT_INVALID_TRANSITION",
          `${from} -> ${to} must be rejected`
        );
      }
    }
  }
});

// AC-10-01
test("AC-10-01: creating an experiment without success_criteria or stopping_criteria is rejected", async () => {
  const { services } = createServices(null);
  const hypothesis = await services.createHypothesis(
    { statement: "s", evidenceNotes: "e" },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
  );

  await assert.rejects(
    () =>
      services.createExperiment(
        hypothesis.hypothesisId,
        { ...VALID_EXPERIMENT_INPUT, successCriteria: undefined },
        { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  await assert.rejects(
    () =>
      services.createExperiment(
        hypothesis.hypothesisId,
        { ...VALID_EXPERIMENT_INPUT, stoppingCriteria: undefined },
        { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
});

// AC-10-04
test("AC-10-04: approved_by/approved_at are null immediately after creation, set only after a real transition into approved", async () => {
  const { services } = createServices(null);
  const hypothesis = await services.createHypothesis({ statement: "s", evidenceNotes: "e" }, { userId: "u1", createdBy: "u1", createdVia: "web_ui" });
  const experiment = await services.createExperiment(hypothesis.hypothesisId, VALID_EXPERIMENT_INPUT, {
    userId: "u1",
    createdBy: "u1",
    createdVia: "web_ui",
  });
  assert.equal(experiment.approvedBy, null);
  assert.equal(experiment.approvedAt, null);
  assert.equal(experiment.status, "proposed");

  const approved = await services.transitionExperiment(
    experiment.experimentId,
    { targetStatus: "approved" },
    { userId: "u1", actor: "approver-1" }
  );
  assert.equal(approved.approvedBy, "approver-1");
  assert.ok(approved.approvedAt);
  assert.equal(approved.status, "approved");
});

// AC-10-05 / AC-10-06
test("AC-10-05/06: channel-scoped hypothesis rejected when not the active channel; channel-less hypothesis needs no check", async () => {
  const calls: string[] = [];
  const { services } = createServices("UCactive0000000000000001", calls);

  await assert.rejects(
    () =>
      services.createHypothesis(
        { channelId: "UCother00000000000000001", statement: "s", evidenceNotes: "e" },
        { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
      ),
    (error: unknown) => isDomainError(error) && error.code === "CHANNEL_NOT_ACTIVE"
  );

  calls.length = 0;
  await services.createHypothesis({ statement: "s", evidenceNotes: "e" }, { userId: "u1", createdBy: "u1", createdVia: "web_ui" });
  assert.deepEqual(calls, [], "no channel-access check should have been attempted for a null channelId");

  // Read path (§5) -- not just creation.
  await assert.rejects(
    () => services.getHypothesis("does-not-exist", { userId: "u1" }),
    (error: unknown) => isDomainError(error) && error.code === "HYPOTHESIS_NOT_FOUND"
  );
  const scoped = await services.createHypothesis(
    { channelId: "UCactive0000000000000001", statement: "s2", evidenceNotes: "e2" },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
  );
  const otherCalls: string[] = [];
  const { services: otherSessionServices, store: otherStore } = createServices("UCother00000000000000001", otherCalls);
  // Same underlying row, viewed from a session whose active channel differs -- the get() path
  // itself, not just create(), must reject.
  otherStore.hypothesesById.set(scoped.hypothesisId, {
    id: scoped.hypothesisId,
    channelId: "UCactive0000000000000001",
    statement: "s2",
    evidenceNotes: "e2",
    createdBy: "u1",
    createdVia: "web_ui",
    createdAt: new Date(),
  });
  await assert.rejects(
    () => otherSessionServices.getHypothesis(scoped.hypothesisId, { userId: "u1" }),
    (error: unknown) => isDomainError(error) && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

// AC-10-07
test("AC-10-07: outcome recording rejected for proposed/approved, allowed for running/concluded/abandoned", async () => {
  const { services } = createServices(null);
  const hypothesis = await services.createHypothesis({ statement: "s", evidenceNotes: "e" }, { userId: "u1", createdBy: "u1", createdVia: "web_ui" });
  const experiment = await services.createExperiment(hypothesis.hypothesisId, VALID_EXPERIMENT_INPUT, {
    userId: "u1",
    createdBy: "u1",
    createdVia: "web_ui",
  });

  const outcomeInput = { outcomeData: "CTR rose 3%", criteriaMet: "met" as const };

  await assert.rejects(
    () => services.createExperimentOutcome(experiment.experimentId, outcomeInput, { userId: "u1", recordedBy: "u1", createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "EXPERIMENT_NOT_OBSERVABLE"
  );

  await services.transitionExperiment(experiment.experimentId, { targetStatus: "approved" }, { userId: "u1", actor: "a1" });
  await assert.rejects(
    () => services.createExperimentOutcome(experiment.experimentId, outcomeInput, { userId: "u1", recordedBy: "u1", createdVia: "web_ui" }),
    (error: unknown) => isDomainError(error) && error.code === "EXPERIMENT_NOT_OBSERVABLE"
  );

  await services.transitionExperiment(experiment.experimentId, { targetStatus: "running" }, { userId: "u1", actor: "a1" });
  const outcome = await services.createExperimentOutcome(experiment.experimentId, outcomeInput, {
    userId: "u1",
    recordedBy: "u1",
    createdVia: "web_ui",
  });
  assert.equal(outcome.outcomeData, "CTR rose 3%");
});

// AC-10-02
test("AC-10-02: no code path inserts an outcome row as a side effect of create/transition", async () => {
  const { services, store } = createServices(null);
  const hypothesis = await services.createHypothesis({ statement: "s", evidenceNotes: "e" }, { userId: "u1", createdBy: "u1", createdVia: "web_ui" });
  const experiment = await services.createExperiment(hypothesis.hypothesisId, VALID_EXPERIMENT_INPUT, {
    userId: "u1",
    createdBy: "u1",
    createdVia: "web_ui",
  });
  await services.transitionExperiment(experiment.experimentId, { targetStatus: "approved" }, { userId: "u1", actor: "a1" });
  await services.transitionExperiment(experiment.experimentId, { targetStatus: "running" }, { userId: "u1", actor: "a1" });
  assert.equal(store.outcomesById.size, 0, "creating/transitioning an experiment must never insert an outcome row");
});

// AC-10-08
test("AC-10-08: a concurrent second transition from a stale expected state fails and leaves the row untouched by the loser", async () => {
  const { services } = createServices(null);
  const hypothesis = await services.createHypothesis({ statement: "s", evidenceNotes: "e" }, { userId: "u1", createdBy: "u1", createdVia: "web_ui" });
  const experiment = await services.createExperiment(hypothesis.hypothesisId, VALID_EXPERIMENT_INPUT, {
    userId: "u1",
    createdBy: "u1",
    createdVia: "web_ui",
  });

  // Both "tabs" read the experiment while it is still "proposed", then both attempt to approve.
  const [first, second] = await Promise.allSettled([
    services.transitionExperiment(experiment.experimentId, { targetStatus: "approved" }, { userId: "u1", actor: "actor-a" }),
    services.transitionExperiment(experiment.experimentId, { targetStatus: "approved" }, { userId: "u1", actor: "actor-b" }),
  ]);

  const outcomes = [first, second];
  const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
  const rejected = outcomes.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one of the two concurrent transitions must succeed");
  assert.equal(rejected.length, 1, "exactly one of the two concurrent transitions must fail");
  const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
  assert.ok(isDomainError(rejectedReason) && rejectedReason.code === "EXPERIMENT_INVALID_TRANSITION");

  const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof services.transitionExperiment>>>).value;
  const finalRow = await services.getExperiment(experiment.experimentId, { userId: "u1" });
  assert.equal(finalRow.approvedBy, winner.approvedBy, "the final row must reflect only the winning call's actor");
});

// AC-10-05e (advisor finding, post-implementation review): cross-channel access must be rejected
// on every route shape that resolves to a channel-scoped hypothesis, not just create/get on the
// hypothesis itself -- createExperiment, listExperimentsByHypothesis, getExperiment,
// transitionExperiment, createExperimentOutcome, and listExperimentOutcomes all delegate to
// assertExperimentAccessible/assertHypothesisAccessible, and each one needs its own proof.
test("AC-10-05e: every experiment/outcome route shape rejects a session active on a different channel", async () => {
  const store = createFakeStore();
  const channelACalls: string[] = [];
  const servicesOnA = createDecisionEngineServices({
    idGenerator: store.idGenerator,
    clock: { now: () => new Date("2026-09-29T12:00:00Z") },
    channelAccess: createFakeChannelAccess("UCactive0000000000000001", channelACalls),
    insertHypothesis: store.insertHypothesis,
    getHypothesisById: store.getHypothesisById,
    listHypotheses: store.listHypotheses,
    insertExperiment: store.insertExperiment,
    getExperimentById: store.getExperimentById,
    listExperimentsByHypothesis: store.listExperimentsByHypothesis,
    transitionExperimentStatusIfValid: store.transitionExperimentStatusIfValid,
    insertExperimentOutcome: store.insertExperimentOutcome,
    listExperimentOutcomesByExperiment: store.listExperimentOutcomesByExperiment,
    insertHypothesisEvidence: store.insertHypothesisEvidence,
    listHypothesisEvidenceByHypothesis: store.listHypothesisEvidenceByHypothesis,
    insertHypothesisGenerationProvenance: store.insertHypothesisGenerationProvenance,
    getHypothesisGenerationProvenanceByHypothesis: store.getHypothesisGenerationProvenanceByHypothesis,
  });
  const servicesOnB = createDecisionEngineServices({
    idGenerator: store.idGenerator,
    clock: { now: () => new Date("2026-09-29T12:00:00Z") },
    channelAccess: createFakeChannelAccess("UCother00000000000000001", []),
    insertHypothesis: store.insertHypothesis,
    getHypothesisById: store.getHypothesisById,
    listHypotheses: store.listHypotheses,
    insertExperiment: store.insertExperiment,
    getExperimentById: store.getExperimentById,
    listExperimentsByHypothesis: store.listExperimentsByHypothesis,
    transitionExperimentStatusIfValid: store.transitionExperimentStatusIfValid,
    insertExperimentOutcome: store.insertExperimentOutcome,
    listExperimentOutcomesByExperiment: store.listExperimentOutcomesByExperiment,
    insertHypothesisEvidence: store.insertHypothesisEvidence,
    listHypothesisEvidenceByHypothesis: store.listHypothesisEvidenceByHypothesis,
    insertHypothesisGenerationProvenance: store.insertHypothesisGenerationProvenance,
    getHypothesisGenerationProvenanceByHypothesis: store.getHypothesisGenerationProvenanceByHypothesis,
  });

  const hypothesis = await servicesOnA.createHypothesis(
    { channelId: "UCactive0000000000000001", statement: "s", evidenceNotes: "e" },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
  );
  const experiment = await servicesOnA.createExperiment(hypothesis.hypothesisId, VALID_EXPERIMENT_INPUT, {
    userId: "u1",
    createdBy: "u1",
    createdVia: "web_ui",
  });
  // Get it running so outcome-recording would otherwise be allowed -- isolates the failure to the
  // channel check, not to EXPERIMENT_NOT_OBSERVABLE.
  await servicesOnA.transitionExperiment(experiment.experimentId, { targetStatus: "approved" }, { userId: "u1", actor: "a1" });
  await servicesOnA.transitionExperiment(experiment.experimentId, { targetStatus: "running" }, { userId: "u1", actor: "a1" });

  const isChannelRejection = (error: unknown) => isDomainError(error) && error.code === "CHANNEL_NOT_ACTIVE";

  await assert.rejects(
    () => servicesOnB.createExperiment(hypothesis.hypothesisId, VALID_EXPERIMENT_INPUT, { userId: "u1", createdBy: "u1", createdVia: "web_ui" }),
    isChannelRejection,
    "createExperiment must reject"
  );
  await assert.rejects(
    () => servicesOnB.listExperimentsByHypothesis(hypothesis.hypothesisId, { userId: "u1" }),
    isChannelRejection,
    "listExperimentsByHypothesis must reject"
  );
  await assert.rejects(
    () => servicesOnB.getExperiment(experiment.experimentId, { userId: "u1" }),
    isChannelRejection,
    "getExperiment must reject"
  );
  await assert.rejects(
    () => servicesOnB.transitionExperiment(experiment.experimentId, { targetStatus: "concluded" }, { userId: "u1", actor: "a1" }),
    isChannelRejection,
    "transitionExperiment must reject"
  );
  await assert.rejects(
    () =>
      servicesOnB.createExperimentOutcome(
        experiment.experimentId,
        { outcomeData: "x", criteriaMet: "met" },
        { userId: "u1", recordedBy: "u1", createdVia: "web_ui" }
      ),
    isChannelRejection,
    "createExperimentOutcome must reject"
  );
  await assert.rejects(
    () => servicesOnB.listExperimentOutcomes(experiment.experimentId, { userId: "u1" }),
    isChannelRejection,
    "listExperimentOutcomes must reject"
  );

  // The experiment's own transition to "running" above must not have been undone by any of the
  // rejected attempts on session B.
  const finalRow = await servicesOnA.getExperiment(experiment.experimentId, { userId: "u1" });
  assert.equal(finalRow.status, "running");
});

// AC-10-05f (advisor finding): listHypotheses's own custom channel filter -- with rows scoped to
// null/A/B and the session active on A, only null and A come back, never B.
test("AC-10-05f: listHypotheses returns channel-less rows plus the active channel's own, never a different channel's", async () => {
  const { services, store } = createServices("UCactive0000000000000001");
  await services.createHypothesis({ statement: "channel-less", evidenceNotes: "e" }, { userId: "u1", createdBy: "u1", createdVia: "web_ui" });
  await services.createHypothesis(
    { channelId: "UCactive0000000000000001", statement: "scoped to active", evidenceNotes: "e" },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
  );

  // A different channel's row is seeded directly into the SAME underlying store (bypassing
  // create's own channel check, exactly like the existing cross-channel get() test does) -- this
  // row must never appear for a session active on a different channel.
  await store.insertHypothesis({
    id: "hyp-other-channel",
    channelId: "UCother00000000000000001",
    statement: "scoped to a different channel",
    evidenceNotes: "e",
    createdBy: "u1",
    createdVia: "web_ui",
  });

  const results = await services.listHypotheses({ userId: "u1" });
  const statements = results.map((h) => h.statement).sort();
  assert.deepEqual(statements, ["channel-less", "scoped to active"]);
});

// AC-10-09: getHypothesisTrail (Phase 10 slice 2, docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md) --
// one hypothesis plus every one of its experiments, each carrying its own outcomes; fails
// HYPOTHESIS_NOT_FOUND for an unknown id before touching experiments at all; enforces channel
// access exactly once (assertHypothesisAccessible), not once per experiment.
test("AC-10-09: getHypothesisTrail surfaces HYPOTHESIS_NOT_FOUND for an unknown id, before listing any experiments", async () => {
  const calls: string[] = [];
  const { services } = createServices(null, calls);
  await assert.rejects(
    () => services.getHypothesisTrail("hyp-unknown", { userId: "u1" }),
    (error: unknown) => isDomainError(error) && error.code === "HYPOTHESIS_NOT_FOUND"
  );
  assert.deepEqual(calls, []);
});

test("AC-10-09: getHypothesisTrail composes one hypothesis with its experiments, each carrying its own outcomes", async () => {
  const { services } = createServices(null);
  const hypothesis = await services.createHypothesis({ statement: "s", evidenceNotes: "e" }, { userId: "u1", createdBy: "u1", createdVia: "web_ui" });
  const experiment = await services.createExperiment(hypothesis.hypothesisId, VALID_EXPERIMENT_INPUT, {
    userId: "u1",
    createdBy: "u1",
    createdVia: "web_ui",
  });
  await services.transitionExperiment(experiment.experimentId, { targetStatus: "approved" }, { userId: "u1", actor: "approver-1" });
  await services.transitionExperiment(experiment.experimentId, { targetStatus: "running" }, { userId: "u1", actor: "approver-1" });
  const outcome = await services.createExperimentOutcome(
    experiment.experimentId,
    { outcomeData: "CTR +6%", criteriaMet: "met" },
    { userId: "u1", recordedBy: "u1", createdVia: "web_ui" }
  );

  const trail = await services.getHypothesisTrail(hypothesis.hypothesisId, { userId: "u1" });

  assert.deepEqual(trail.hypothesis, hypothesis);
  assert.equal(trail.experiments.length, 1);
  assert.equal(trail.experiments[0].experimentId, experiment.experimentId);
  assert.deepEqual(trail.experiments[0].outcomes, [outcome]);
});

test("AC-10-09: getHypothesisTrail enforces channel access exactly once, not once per experiment", async () => {
  const calls: string[] = [];
  const { services } = createServices("UCactive0000000000000001", calls);
  const hypothesis = await services.createHypothesis(
    { channelId: "UCactive0000000000000001", statement: "scoped", evidenceNotes: "e" },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
  );
  calls.length = 0;
  await services.createExperiment(hypothesis.hypothesisId, VALID_EXPERIMENT_INPUT, { userId: "u1", createdBy: "u1", createdVia: "web_ui" });
  calls.length = 0;

  await services.getHypothesisTrail(hypothesis.hypothesisId, { userId: "u1" });

  assert.deepEqual(calls, ["UCactive0000000000000001"]);
});

// ---------------------------------------------------------------------------
// Phase 10 slice 3 (docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md §9) -- structured evidence
// references. `resolver` is a fake `EvidenceReferenceResolver`, exactly the shape the real route
// file supplies in production (services.ts never constructs one itself).
// ---------------------------------------------------------------------------

function createFakeResolver(resolvesTo: boolean, calls: unknown[] = []) {
  return {
    async resolve(reference: unknown, ctx: unknown) {
      calls.push({ reference, ctx });
      return resolvesTo;
    },
    async describe(reference: unknown) {
      return `fake description of ${JSON.stringify(reference)}`;
    },
  };
}

test("AC-10-10: a reference the resolver confirms exists is accepted and stored", async () => {
  const { services } = createServices(null);
  const hypothesis = await services.createHypothesis(
    { statement: "s", evidenceNotes: "e" },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
  );
  const resolver = createFakeResolver(true);

  const evidence = await services.addHypothesisEvidence(
    hypothesis.hypothesisId,
    { reference: { sourceType: "phase9_trend_candidate", trendCandidateId: "trend-1" } },
    { userId: "u1", createdVia: "web_ui" },
    resolver
  );

  assert.equal(evidence.hypothesisId, hypothesis.hypothesisId);
  assert.deepEqual(evidence.reference, { sourceType: "phase9_trend_candidate", trendCandidateId: "trend-1" });

  const listed = await services.listHypothesisEvidence(hypothesis.hypothesisId, { userId: "u1" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].evidenceId, evidence.evidenceId);
});

test("AC-10-11: a reference the resolver reports as not existing is rejected, and nothing is stored", async () => {
  const { services } = createServices(null);
  const hypothesis = await services.createHypothesis(
    { statement: "s", evidenceNotes: "e" },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
  );
  const resolver = createFakeResolver(false);

  await assert.rejects(
    () =>
      services.addHypothesisEvidence(
        hypothesis.hypothesisId,
        { reference: { sourceType: "phase9_trend_candidate", trendCandidateId: "fabricated" } },
        { userId: "u1", createdVia: "web_ui" },
        resolver
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );

  const listed = await services.listHypothesisEvidence(hypothesis.hypothesisId, { userId: "u1" });
  assert.equal(listed.length, 0);
});

test("AC-10-12: a phase8_metric reference whose channelId differs from a channel-scoped hypothesis's own channelId is rejected, even though the resolver would confirm it exists", async () => {
  const { services } = createServices("UCactive0000000000000001");
  const hypothesis = await services.createHypothesis(
    { channelId: "UCactive0000000000000001", statement: "s", evidenceNotes: "e" },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
  );
  const resolverCalls: unknown[] = [];
  const resolver = createFakeResolver(true, resolverCalls);

  await assert.rejects(
    () =>
      services.addHypothesisEvidence(
        hypothesis.hypothesisId,
        {
          reference: {
            sourceType: "phase8_metric",
            channelId: "UCother00000000000000001",
            videoId: "v1",
            metricDate: "2026-09-01",
            metricName: "views",
          },
        },
        { userId: "u1", createdVia: "web_ui" },
        resolver
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
  assert.equal(resolverCalls.length, 0, "the resolver must never be called once the channel mismatch is already known");
});

test("AC-10-13: a phase8_metric reference is accepted for a channel-less hypothesis regardless of which channel it names", async () => {
  const { services } = createServices(null);
  const hypothesis = await services.createHypothesis(
    { statement: "new channel concept", evidenceNotes: "e" },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
  );
  const resolver = createFakeResolver(true);

  const evidence = await services.addHypothesisEvidence(
    hypothesis.hypothesisId,
    {
      reference: {
        sourceType: "phase8_metric",
        channelId: "UCanyChannel000000000001",
        videoId: "v1",
        metricDate: "2026-09-01",
        metricName: "views",
      },
    },
    { userId: "u1", createdVia: "web_ui" },
    resolver
  );

  assert.equal(evidence.reference.sourceType, "phase8_metric");
});

test("AC-10-14: getHypothesisTrail includes structured evidence alongside experiments/outcomes", async () => {
  const { services } = createServices(null);
  const hypothesis = await services.createHypothesis(
    { statement: "s", evidenceNotes: "e" },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
  );
  const resolver = createFakeResolver(true);
  await services.addHypothesisEvidence(
    hypothesis.hypothesisId,
    { reference: { sourceType: "phase9_trend_candidate", trendCandidateId: "trend-1" } },
    { userId: "u1", createdVia: "web_ui" },
    resolver
  );

  const trail = await services.getHypothesisTrail(hypothesis.hypothesisId, { userId: "u1" });

  assert.equal(trail.evidence.length, 1);
  assert.deepEqual(trail.evidence[0].reference, { sourceType: "phase9_trend_candidate", trendCandidateId: "trend-1" });
});

test("AC-10-15: addHypothesisEvidence/listHypothesisEvidence reject a session active on a different channel than the hypothesis", async () => {
  const store = createFakeStore();
  const servicesOnA = createDecisionEngineServices({
    idGenerator: store.idGenerator,
    clock: { now: () => new Date("2026-09-29T12:00:00Z") },
    channelAccess: createFakeChannelAccess("UCactive0000000000000001", []),
    insertHypothesis: store.insertHypothesis,
    getHypothesisById: store.getHypothesisById,
    listHypotheses: store.listHypotheses,
    insertExperiment: store.insertExperiment,
    getExperimentById: store.getExperimentById,
    listExperimentsByHypothesis: store.listExperimentsByHypothesis,
    transitionExperimentStatusIfValid: store.transitionExperimentStatusIfValid,
    insertExperimentOutcome: store.insertExperimentOutcome,
    listExperimentOutcomesByExperiment: store.listExperimentOutcomesByExperiment,
    insertHypothesisEvidence: store.insertHypothesisEvidence,
    listHypothesisEvidenceByHypothesis: store.listHypothesisEvidenceByHypothesis,
    insertHypothesisGenerationProvenance: store.insertHypothesisGenerationProvenance,
    getHypothesisGenerationProvenanceByHypothesis: store.getHypothesisGenerationProvenanceByHypothesis,
  });
  const servicesOnB = createDecisionEngineServices({
    idGenerator: store.idGenerator,
    clock: { now: () => new Date("2026-09-29T12:00:00Z") },
    channelAccess: createFakeChannelAccess("UCother00000000000000001", []),
    insertHypothesis: store.insertHypothesis,
    getHypothesisById: store.getHypothesisById,
    listHypotheses: store.listHypotheses,
    insertExperiment: store.insertExperiment,
    getExperimentById: store.getExperimentById,
    listExperimentsByHypothesis: store.listExperimentsByHypothesis,
    transitionExperimentStatusIfValid: store.transitionExperimentStatusIfValid,
    insertExperimentOutcome: store.insertExperimentOutcome,
    listExperimentOutcomesByExperiment: store.listExperimentOutcomesByExperiment,
    insertHypothesisEvidence: store.insertHypothesisEvidence,
    listHypothesisEvidenceByHypothesis: store.listHypothesisEvidenceByHypothesis,
    insertHypothesisGenerationProvenance: store.insertHypothesisGenerationProvenance,
    getHypothesisGenerationProvenanceByHypothesis: store.getHypothesisGenerationProvenanceByHypothesis,
  });

  const hypothesis = await servicesOnA.createHypothesis(
    { channelId: "UCactive0000000000000001", statement: "s", evidenceNotes: "e" },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" }
  );
  const resolver = createFakeResolver(true);

  await assert.rejects(
    () =>
      servicesOnB.addHypothesisEvidence(
        hypothesis.hypothesisId,
        { reference: { sourceType: "phase9_trend_candidate", trendCandidateId: "trend-1" } },
        { userId: "u2", createdVia: "web_ui" },
        resolver
      ),
    (error: unknown) => isDomainError(error) && error.code === "CHANNEL_NOT_ACTIVE"
  );
  await assert.rejects(
    () => servicesOnB.listHypothesisEvidence(hypothesis.hypothesisId, { userId: "u2" }),
    (error: unknown) => isDomainError(error) && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

// ---------------------------------------------------------------------------
// Phase 10 slice 4 (docs/roadmap/plans/PHASE_10_SLICE_4_PLAN.md §6) -- AI-generated hypothesis
// drafts. `createFakeProvider` is a fake `HypothesisDraftProvider`, exactly the shape
// `resolveHypothesisDraftProvider` supplies in production (services.ts never constructs one
// itself, mirroring the `resolver` port's own precedent above).
// ---------------------------------------------------------------------------

function createFakeProvider(overrides?: {
  generateHypothesis?: (request: unknown) => Promise<{ status: "ok"; statement: string; rationale: string } | { status: "error"; message: string }>;
}) {
  return {
    name: "fake-provider",
    async generateHypothesis(request: unknown) {
      if (overrides?.generateHypothesis) return overrides.generateHypothesis(request);
      return { status: "ok" as const, statement: "Generated statement", rationale: "Generated rationale" };
    },
  };
}

function createServicesWithProvider(
  activeChannelId: string | null,
  provider: ReturnType<typeof createFakeProvider> | null,
  calls: string[] = []
) {
  const store = createFakeStore();
  const services = createDecisionEngineServices({
    idGenerator: store.idGenerator,
    clock: { now: () => new Date("2026-09-29T12:00:00Z") },
    channelAccess: createFakeChannelAccess(activeChannelId, calls),
    insertHypothesis: store.insertHypothesis,
    getHypothesisById: store.getHypothesisById,
    listHypotheses: store.listHypotheses,
    insertExperiment: store.insertExperiment,
    getExperimentById: store.getExperimentById,
    listExperimentsByHypothesis: store.listExperimentsByHypothesis,
    transitionExperimentStatusIfValid: store.transitionExperimentStatusIfValid,
    insertExperimentOutcome: store.insertExperimentOutcome,
    listExperimentOutcomesByExperiment: store.listExperimentOutcomesByExperiment,
    insertHypothesisEvidence: store.insertHypothesisEvidence,
    listHypothesisEvidenceByHypothesis: store.listHypothesisEvidenceByHypothesis,
    insertHypothesisGenerationProvenance: store.insertHypothesisGenerationProvenance,
    getHypothesisGenerationProvenanceByHypothesis: store.getHypothesisGenerationProvenanceByHypothesis,
    resolveHypothesisDraftProvider: provider ? async () => provider : undefined,
  });
  return { services, store };
}

// AC-10H-01
test("AC-10H-01: generating with zero evidence and saving creates exactly one hypothesis and one provenance row, zero evidence rows", async () => {
  const { services } = createServicesWithProvider(null, createFakeProvider());
  const resolver = createFakeResolver(true);

  const draft = await services.generateHypothesisDraft(
    { notes: "operator notes", evidenceReferences: [] },
    { userId: "u1" },
    resolver
  );
  assert.equal(draft.statement, "Generated statement");
  assert.equal(draft.providerName, "fake-provider");

  const hypothesis = await services.saveGeneratedHypothesis(
    {
      finalStatement: draft.statement,
      evidenceNotes: "operator notes",
      evidenceReferences: [],
      generatedStatement: draft.statement,
      rationale: "Generated rationale",
      providerName: draft.providerName,
    },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" },
    resolver
  );

  const allHypotheses = await services.listHypotheses({ userId: "u1" });
  assert.equal(allHypotheses.length, 1);
  assert.equal(allHypotheses[0]?.hypothesisId, hypothesis.hypothesisId);

  const evidence = await services.listHypothesisEvidence(hypothesis.hypothesisId, { userId: "u1" });
  assert.equal(evidence.length, 0);
});

// AC-10H-02
test("AC-10H-02: saving an edited statement with 2 evidence references records editedBeforeSave and both evidence rows, each independently re-validated", async () => {
  const { services } = createServicesWithProvider(null, createFakeProvider());
  const resolveCalls: unknown[] = [];
  const resolver = createFakeResolver(true, resolveCalls);

  const refs = [
    { sourceType: "phase9_trend_candidate" as const, trendCandidateId: "trend-1" },
    { sourceType: "phase9_trend_candidate" as const, trendCandidateId: "trend-2" },
  ];

  const draft = await services.generateHypothesisDraft({ notes: "n", evidenceReferences: refs }, { userId: "u1" }, resolver);
  const resolveCallsAfterGenerate = resolveCalls.length;
  assert.equal(resolveCallsAfterGenerate, 2, "generation must validate each selected reference before describing it");

  const editedStatement = draft.statement + " (edited by operator)";
  const hypothesis = await services.saveGeneratedHypothesis(
    {
      finalStatement: editedStatement,
      evidenceNotes: "n",
      evidenceReferences: refs,
      generatedStatement: draft.statement,
      rationale: "r",
      providerName: draft.providerName,
    },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" },
    resolver
  );

  assert.equal(resolveCalls.length, resolveCallsAfterGenerate + 2, "save must independently re-validate every reference, never trust generation-time resolution");

  const evidence = await services.listHypothesisEvidence(hypothesis.hypothesisId, { userId: "u1" });
  assert.equal(evidence.length, 2);

  const provenance = await services.getHypothesisGenerationProvenance(hypothesis.hypothesisId, { userId: "u1" });
  assert.ok(provenance);
  assert.equal(provenance.evidenceRefCount, 2);
  assert.equal(provenance.editedBeforeSave, true);
  assert.equal(provenance.generatedStatement, draft.statement);
  assert.equal(provenance.finalStatement, editedStatement);
});

// AC-10H-03
test("AC-10H-03: saving without editing the statement records editedBeforeSave: false", async () => {
  const { services } = createServicesWithProvider(null, createFakeProvider());
  const resolver = createFakeResolver(true);
  const draft = await services.generateHypothesisDraft({ notes: "n", evidenceReferences: [] }, { userId: "u1" }, resolver);

  const hypothesis = await services.saveGeneratedHypothesis(
    {
      finalStatement: draft.statement,
      evidenceNotes: "n",
      evidenceReferences: [],
      generatedStatement: draft.statement,
      rationale: "r",
      providerName: draft.providerName,
    },
    { userId: "u1", createdBy: "u1", createdVia: "web_ui" },
    resolver
  );
  const provenance = await services.getHypothesisGenerationProvenance(hypothesis.hypothesisId, { userId: "u1" });
  assert.equal(provenance?.editedBeforeSave, false);
});

// AC-10H-04
test("AC-10H-04: a reference that fails validation at save time is rejected, even if it was valid at generation time", async () => {
  const { services } = createServicesWithProvider(null, createFakeProvider());
  const generateResolver = createFakeResolver(true);
  const ref = { sourceType: "phase9_trend_candidate" as const, trendCandidateId: "trend-1" };
  const draft = await services.generateHypothesisDraft({ notes: "n", evidenceReferences: [ref] }, { userId: "u1" }, generateResolver);

  const saveResolver = createFakeResolver(false); // state changed since generation -- no longer resolves
  await assert.rejects(
    () =>
      services.saveGeneratedHypothesis(
        {
          finalStatement: draft.statement,
          evidenceNotes: "n",
          evidenceReferences: [ref],
          generatedStatement: draft.statement,
          rationale: "r",
          providerName: draft.providerName,
        },
        { userId: "u1", createdBy: "u1", createdVia: "web_ui" },
        saveResolver
      ),
    (error: unknown) => isDomainError(error) && error.code === "validation_failed"
  );
});

// AC-10H-05
test("AC-10H-05: a provider that returns a status:error outcome throws generation_failed and persists nothing", async () => {
  const provider = createFakeProvider({
    generateHypothesis: async () => ({ status: "error", message: "upstream refused" }),
  });
  const { services } = createServicesWithProvider(null, provider);
  const resolver = createFakeResolver(true);

  await assert.rejects(
    () => services.generateHypothesisDraft({ notes: "n", evidenceReferences: [] }, { userId: "u1" }, resolver),
    (error: unknown) => isDomainError(error) && error.code === "generation_failed"
  );
  const allHypotheses = await services.listHypotheses({ userId: "u1" });
  assert.equal(allHypotheses.length, 0);
});

// AC-10H-06
test("AC-10H-06: a provider that throws synchronously does not crash the call -- it propagates as a real error, never silently swallowed", async () => {
  const provider = createFakeProvider({
    generateHypothesis: async () => {
      throw new Error("network exploded");
    },
  });
  const { services } = createServicesWithProvider(null, provider);
  const resolver = createFakeResolver(true);

  await assert.rejects(
    () => services.generateHypothesisDraft({ notes: "n", evidenceReferences: [] }, { userId: "u1" }, resolver),
    (error: unknown) => error instanceof Error && error.message === "network exploded"
  );
});

// AC-10H-07
test("AC-10H-07: generateHypothesisDraft with a channelId the session isn't authorized for is rejected before any provider call is made", async () => {
  let providerCalled = false;
  const provider = createFakeProvider({
    generateHypothesis: async () => {
      providerCalled = true;
      return { status: "ok", statement: "s", rationale: "r" };
    },
  });
  const { services } = createServicesWithProvider("UCactive0000000000000001", provider);
  const resolver = createFakeResolver(true);

  await assert.rejects(
    () =>
      services.generateHypothesisDraft(
        { channelId: "UCother00000000000000001", notes: "n", evidenceReferences: [] },
        { userId: "u1" },
        resolver
      ),
    (error: unknown) => isDomainError(error) && error.code === "CHANNEL_NOT_ACTIVE"
  );
  assert.equal(providerCalled, false, "the provider must never be called once channel access is rejected");
});

// AC-10H-08
test("AC-10H-08: generateHypothesisDraft throws provider_not_configured when no provider resolver is wired", async () => {
  const { services } = createServicesWithProvider(null, null);
  const resolver = createFakeResolver(true);

  await assert.rejects(
    () => services.generateHypothesisDraft({ notes: "n", evidenceReferences: [] }, { userId: "u1" }, resolver),
    (error: unknown) => isDomainError(error) && error.code === "provider_not_configured"
  );
});
