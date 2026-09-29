import {
  getExperimentById,
  getHypothesisById,
  insertExperiment,
  insertExperimentOutcome,
  insertHypothesis,
  listExperimentOutcomesByExperiment,
  listExperimentsByHypothesis,
  listHypotheses,
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
  };
}
