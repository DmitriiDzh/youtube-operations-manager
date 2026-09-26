import {
  claimStaleResearchChannelsForCollection,
  deleteResearchChannel,
  getMarketIntelligenceDailyQuotaBudgetUnits,
  getMarketIntelligenceUnitsSpentSince,
  getResearchChannelById,
  insertMarketChannelSnapshot,
  insertMarketIntelligenceCollectionRun,
  insertMarketVideoSnapshot,
  insertResearchChannel,
  insertResearchEvidence,
  listMarketChannelSnapshotsByChannel,
  listMarketVideoSnapshotsByChannel,
  listRecentlyFailedResearchChannelIds,
  listResearchChannels,
  listResearchEvidenceByChannel,
  markResearchChannelAutoCollected,
  releaseResearchChannelCollectionClaim,
  setMarketIntelligenceDailyQuotaBudgetUnits,
} from "@/lib/db";
import { createIdGenerator } from "../contracts";

// Deliberately thin: only wraps the db.ts functions this module needs (AGENTS.md §D -- one
// SQLite connection, `db.ts` owns all of it). Never touches channels/videos.
export function createMarketIntelligenceStoreAdapter() {
  return {
    idGenerator: createIdGenerator(),
    insertResearchChannel,
    listResearchChannels,
    getResearchChannelById,
    deleteResearchChannel,
    insertResearchEvidence,
    listResearchEvidenceByChannel,
    // Phase 9 slice 9A (docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md).
    insertMarketChannelSnapshot,
    listMarketChannelSnapshotsByChannel,
    insertMarketVideoSnapshot,
    listMarketVideoSnapshotsByChannel,
    // Phase 9 slice 9B (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md).
    markResearchChannelAutoCollected,
    insertMarketIntelligenceCollectionRun,
    getMarketIntelligenceUnitsSpentSince,
    getMarketIntelligenceDailyQuotaBudgetUnits,
    setMarketIntelligenceDailyQuotaBudgetUnits,
    claimStaleResearchChannelsForCollection,
    releaseResearchChannelCollectionClaim,
    listRecentlyFailedResearchChannelIds,
  };
}

export type MarketIntelligenceStoreAdapter = ReturnType<typeof createMarketIntelligenceStoreAdapter>;
