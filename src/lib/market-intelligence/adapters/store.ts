import {
  claimStaleResearchChannelsForCollection,
  deleteResearchChannel,
  getMarketDiscoveryCandidateById,
  getMarketIntelligenceDailyQuotaBudgetUnits,
  getMarketIntelligenceUnitsSpentSince,
  getResearchChannelById,
  insertMarketChannelSnapshot,
  insertMarketDiscoveryCandidate,
  insertMarketDiscoveryRun,
  insertMarketIntelligenceCollectionRun,
  insertMarketVideoSnapshot,
  insertResearchChannel,
  insertResearchEvidence,
  listMarketChannelSnapshotsByChannel,
  listMarketDiscoveryCandidates,
  listMarketVideoSnapshotsByChannel,
  listRecentlyFailedResearchChannelIds,
  listResearchChannels,
  listResearchEvidenceByChannel,
  markResearchChannelAutoCollected,
  releaseResearchChannelCollectionClaim,
  setMarketDiscoveryCandidateStatus,
  setMarketIntelligenceDailyQuotaBudgetUnits,
  touchMarketDiscoveryCandidateLastSeen,
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
    // Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md).
    getMarketDiscoveryCandidateById,
    listMarketDiscoveryCandidates,
    insertMarketDiscoveryCandidate,
    touchMarketDiscoveryCandidateLastSeen,
    setMarketDiscoveryCandidateStatus,
    insertMarketDiscoveryRun,
  };
}

export type MarketIntelligenceStoreAdapter = ReturnType<typeof createMarketIntelligenceStoreAdapter>;
