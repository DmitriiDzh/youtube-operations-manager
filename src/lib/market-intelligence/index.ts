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
    insertMarketChannelSnapshot: store.insertMarketChannelSnapshot,
    listMarketChannelSnapshotsByChannel: store.listMarketChannelSnapshotsByChannel,
    insertMarketVideoSnapshot: store.insertMarketVideoSnapshot,
    listMarketVideoSnapshotsByChannel: store.listMarketVideoSnapshotsByChannel,
    authResolver: defaultAuthResolver(),
    youtubeApi: createMarketIntelligenceYoutubeApiAdapter(),
    // Phase 9 slice 9B (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md).
    clock: { now: () => new Date() },
    getMarketIntelligenceDailyQuotaBudgetUnits: store.getMarketIntelligenceDailyQuotaBudgetUnits,
    setMarketIntelligenceDailyQuotaBudgetUnits: store.setMarketIntelligenceDailyQuotaBudgetUnits,
    getMarketIntelligenceUnitsSpentSince: store.getMarketIntelligenceUnitsSpentSince,
    claimStaleResearchChannelsForCollection: store.claimStaleResearchChannelsForCollection,
    releaseResearchChannelCollectionClaim: store.releaseResearchChannelCollectionClaim,
    listRecentlyFailedResearchChannelIds: store.listRecentlyFailedResearchChannelIds,
    markResearchChannelAutoCollected: store.markResearchChannelAutoCollected,
    insertMarketIntelligenceCollectionRun: store.insertMarketIntelligenceCollectionRun,
  });
}

export type MarketIntelligenceCore = ReturnType<typeof createMarketIntelligenceCore>;
export type { ResearchChannel, ResearchEvidence, MarketChannelSnapshot, MarketVideoSnapshot } from "./contracts";
export { DomainError, isDomainError } from "./contracts";
