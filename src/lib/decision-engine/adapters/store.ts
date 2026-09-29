import {
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
    insertExperimentOutcome,
    listExperimentOutcomesByExperiment,
    insertHypothesisEvidence,
    listHypothesisEvidenceByHypothesis,
    insertHypothesisGenerationProvenance,
    getHypothesisGenerationProvenanceByHypothesis,
  };
}
