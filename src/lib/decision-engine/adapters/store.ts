import {
  claimExperimentForExecution,
  finalizeExperimentExecution,
  getExperimentById,
  getHypothesisById,
  getHypothesisGenerationProvenanceByHypothesis,
  insertExperiment,
  insertExperimentOutcome,
  insertHypothesis,
  insertHypothesisEvidence,
  insertHypothesisGenerationProvenance,
  listExperimentOutcomesByExperiment,
  listExperimentsByHypothesis,
  listHypotheses,
  listHypothesisEvidenceByHypothesis,
  releaseExperimentExecutionClaim,
  setExperimentChangeSetIfEligible,
  transitionExperimentStatusIfValid,
} from "@/lib/db";
import { createIdGenerator } from "../contracts";

export function createDecisionEngineStoreAdapter() {
  return {
    idGenerator: createIdGenerator(),
    insertHypothesis,
    getHypothesisById,
    listHypotheses,
    insertExperiment,
    getExperimentById,
    listExperimentsByHypothesis,
    transitionExperimentStatusIfValid,
    setExperimentChangeSetIfEligible,
    claimExperimentForExecution,
    releaseExperimentExecutionClaim,
    finalizeExperimentExecution,
    insertExperimentOutcome,
    listExperimentOutcomesByExperiment,
    insertHypothesisEvidence,
    listHypothesisEvidenceByHypothesis,
    insertHypothesisGenerationProvenance,
    getHypothesisGenerationProvenanceByHypothesis,
  };
}
