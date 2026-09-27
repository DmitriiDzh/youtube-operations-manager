import {
  claimStaleResearchChannelsForCollection,
  deleteMarketTopic,
  deleteMarketTopicAssignment,
  deleteResearchChannel,
  getMarketDiscoveryCandidateById,
  getMarketIntelligenceDailyQuotaBudgetUnits,
  getMarketIntelligenceUnitsSpentSince,
  getMarketTopicById,
  getResearchChannelById,
  getTopicAssignment,
  insertMarketChannelSnapshot,
  insertMarketDiscoveryCandidate,
  insertMarketDiscoveryRun,
  insertMarketIntelligenceCollectionRun,
  insertMarketTopic,
  insertMarketTopicAssignment,
  insertMarketVideoSnapshot,
  insertResearchChannel,
  insertResearchEvidence,
  listAssignmentsForTopic,
  listMarketChannelSnapshotsByChannel,
  listMarketDiscoveryCandidates,
  listMarketTopics,
  listMarketVideoSnapshotsByChannel,
  listRecentlyFailedResearchChannelIds,
  listResearchChannels,
  listResearchEvidenceByChannel,
  listTopicsForSubject,
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
    // Phase 9 slice 9E (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md) -- topic model, part A.
    listMarketTopics,
    getMarketTopicById,
    insertMarketTopic,
    deleteMarketTopic,
    listAssignmentsForTopic,
    listTopicsForSubject,
    getTopicAssignment,
    insertMarketTopicAssignment,
    deleteMarketTopicAssignment,
  };
}

export type MarketIntelligenceStoreAdapter = ReturnType<typeof createMarketIntelligenceStoreAdapter>;
