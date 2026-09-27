import {
  approveMarketResearchRequestIfPending,
  claimStaleResearchChannelsForCollection,
  deleteMarketTopic,
  deleteMarketTopicAssignment,
  deleteResearchChannel,
  getLatestMarketIntelligenceCollectionRunForChannel,
  getMarketDiscoveryCandidateById,
  getMarketIntelligenceDailyQuotaBudgetUnits,
  getMarketIntelligenceUnitsSpentSince,
  getMarketResearchRequestById,
  getMarketTopicById,
  getMarketTrendCandidateById,
  getResearchChannelById,
  getTopicAssignment,
  insertMarketChannelSnapshot,
  insertMarketDiscoveryCandidate,
  insertMarketDiscoveryRun,
  insertMarketIntelligenceCollectionRun,
  insertMarketResearchRequest,
  insertMarketTopic,
  insertMarketTopicAssignment,
  insertMarketTrendEvidence,
  insertMarketVideoSnapshot,
  insertResearchChannel,
  insertResearchEvidence,
  insertMarketTrendCandidateWithInitialEvidence,
  listAssignmentsForTopic,
  listMarketChannelSnapshotsByChannel,
  listMarketDiscoveryCandidates,
  listMarketResearchRequests,
  listMarketTopicAssignmentsBySubjectType,
  listMarketTopics,
  listMarketTrendCandidates,
  listMarketVideoSnapshotsByChannel,
  listRecentlyFailedResearchChannelIds,
  listResearchChannels,
  listResearchEvidenceByChannel,
  listTopicsForSubject,
  listTrendEvidence,
  markResearchChannelAutoCollected,
  recordMarketResearchRequestExecutionOutcome,
  rejectMarketResearchRequestIfPending,
  releaseResearchChannelCollectionClaim,
  setMarketDiscoveryCandidateStatus,
  setMarketIntelligenceDailyQuotaBudgetUnits,
  touchMarketDiscoveryCandidateLastSeen,
  touchMarketTrendCandidateLastObservedAt,
  updateMarketTrendCandidateStatusWithEvidence,
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
    // Phase 9 slice 9H part C (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_C_PLAN.md).
    listMarketTopicAssignmentsBySubjectType,
    getTopicAssignment,
    insertMarketTopicAssignment,
    deleteMarketTopicAssignment,
    // Phase 9 slice 9E (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md) -- trend candidates, part B.
    // `insertMarketTrendCandidateWithInitialEvidence`/`updateMarketTrendCandidateStatusWithEvidence` are the
    // atomic (single-transaction) forms found necessary by independent review -- see their own
    // doc comments in db.ts (closes `docs/TECHNICAL_DEBT.md` RISK-70 and its status-change sibling).
    listMarketTrendCandidates,
    getMarketTrendCandidateById,
    insertMarketTrendCandidateWithInitialEvidence,
    updateMarketTrendCandidateStatusWithEvidence,
    touchMarketTrendCandidateLastObservedAt,
    listTrendEvidence,
    insertMarketTrendEvidence,
    // Phase 9 slice 9G, part A (docs/roadmap/plans/PHASE_9_SLICE_9G_PLAN.md) -- agent read surface.
    getLatestMarketIntelligenceCollectionRunForChannel,
    // Phase 9 slice 9G, part B (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md) -- agent-created
    // research requests. The two conditional-transition functions are the atomic approval-integrity
    // guard this slice's own design depends on -- see their own doc comments in db.ts.
    insertMarketResearchRequest,
    getMarketResearchRequestById,
    listMarketResearchRequests,
    approveMarketResearchRequestIfPending,
    rejectMarketResearchRequestIfPending,
    recordMarketResearchRequestExecutionOutcome,
  };
}

export type MarketIntelligenceStoreAdapter = ReturnType<typeof createMarketIntelligenceStoreAdapter>;
