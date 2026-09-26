import { createMarketIntelligenceStoreAdapter } from "./adapters/store";
import { createMarketIntelligenceServices } from "./services";

export function createMarketIntelligenceCore() {
  const store = createMarketIntelligenceStoreAdapter();

  return createMarketIntelligenceServices({
    idGenerator: store.idGenerator,
    insertResearchChannel: store.insertResearchChannel,
    listResearchChannels: store.listResearchChannels,
    getResearchChannelById: store.getResearchChannelById,
    insertResearchEvidence: store.insertResearchEvidence,
    listResearchEvidenceByChannel: store.listResearchEvidenceByChannel,
  });
}

export type MarketIntelligenceCore = ReturnType<typeof createMarketIntelligenceCore>;
export type { ResearchChannel, ResearchEvidence } from "./contracts";
export { DomainError, isDomainError } from "./contracts";
