import { createChannelAccessCore } from "@/lib/channel-access";
import { createDecisionEngineStoreAdapter } from "./adapters/store";
import { createDecisionEngineServices } from "./services";

export function createDecisionEngineCore() {
  const store = createDecisionEngineStoreAdapter();

  return createDecisionEngineServices({
    idGenerator: store.idGenerator,
    clock: { now: () => new Date() },
    channelAccess: createChannelAccessCore(),
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
  });
}

export type DecisionEngineCore = ReturnType<typeof createDecisionEngineCore>;
export type {
  EvidenceReference,
  EvidenceReferenceResolver,
  Experiment,
  ExperimentOutcome,
  ExperimentStatus,
  Hypothesis,
  HypothesisEvidence,
} from "./contracts";
export { DomainError, isDomainError } from "./contracts";
