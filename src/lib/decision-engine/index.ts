import { createChannelAccessCore } from "@/lib/channel-access";
import { createAiConnectionCore } from "@/lib/ai-connections";
import { assertDeviceAvailableForMutation } from "@/lib/device-handoff";
import { rawSqlClient } from "@/lib/db";
import { createMockHypothesisDraftProvider } from "./adapters/mock-provider";
import { createDecisionEngineStoreAdapter } from "./adapters/store";
import { createDecisionEngineServices } from "./services";
import type { HypothesisDraftProvider } from "./contracts";

export function createDecisionEngineCore() {
  const store = createDecisionEngineStoreAdapter();
  const connectionCore = createAiConnectionCore();
  const mockProvider = createMockHypothesisDraftProvider();

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
    // Phase 10 slice 4 -- `undefined` connectionId means "use the mock provider" (no DB lookup,
    // matches ai-localization's own default-to-mock behavior); a real connectionId is resolved
    // through ai-connections exactly like ai-localization's own `resolveConnectionProvider`.
    resolveHypothesisDraftProvider: async (connectionId: string | undefined): Promise<HypothesisDraftProvider> =>
      connectionId ? connectionCore.resolveHypothesisGenerationProvider(connectionId) : mockProvider,
    assertDeviceAvailable: () => assertDeviceAvailableForMutation(rawSqlClient),
    insertHypothesisGenerationProvenance: store.insertHypothesisGenerationProvenance,
    getHypothesisGenerationProvenanceByHypothesis: store.getHypothesisGenerationProvenanceByHypothesis,
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
