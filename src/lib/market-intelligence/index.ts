import { resolveGoogleCredentials } from "@/lib/video-metadata/adapters/google-auth";
import { createMarketIntelligenceStoreAdapter } from "./adapters/store";
import { createMarketIntelligenceYoutubeApiAdapter } from "./adapters/youtube-api";
import { createMarketIntelligenceServices } from "./services";

function defaultAuthResolver() {
  return {
    resolve: resolveGoogleCredentials,
  };
}

export function createMarketIntelligenceCore() {
  const store = createMarketIntelligenceStoreAdapter();

  return createMarketIntelligenceServices({
    idGenerator: store.idGenerator,
    insertResearchChannel: store.insertResearchChannel,
    listResearchChannels: store.listResearchChannels,
    getResearchChannelById: store.getResearchChannelById,
    deleteResearchChannel: store.deleteResearchChannel,
    insertResearchEvidence: store.insertResearchEvidence,
    listResearchEvidenceByChannel: store.listResearchEvidenceByChannel,
    authResolver: defaultAuthResolver(),
    youtubeApi: createMarketIntelligenceYoutubeApiAdapter(),
  });
}

export type MarketIntelligenceCore = ReturnType<typeof createMarketIntelligenceCore>;
export type { ResearchChannel, ResearchEvidence } from "./contracts";
export { DomainError, isDomainError } from "./contracts";
