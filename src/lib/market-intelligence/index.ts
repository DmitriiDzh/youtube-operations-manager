import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createMarketIntelligenceStoreAdapter } from "./adapters/store";
import { createMarketIntelligenceYoutubeApiAdapter } from "./adapters/youtube-api";
import { createQuotaGuardCore } from "@/lib/quota-guard";
import { quotaScoped } from "@/lib/youtube-quota";
import { createMarketIntelligenceServices } from "./services";

function defaultAuthResolver() {
  return {
    resolve: resolveGoogleCredentials,
  };
}

export function createMarketIntelligenceCore() {
  const store = createMarketIntelligenceStoreAdapter();

  const services = createMarketIntelligenceServices({
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
    getMarketIntelligenceCollectionDepthDefaults: store.getMarketIntelligenceCollectionDepthDefaults,
    setMarketIntelligenceCollectionDepthDefaults: store.setMarketIntelligenceCollectionDepthDefaults,
    setResearchChannelCollectionDepth: store.setResearchChannelCollectionDepth,
    saveResearchChannelCollectionProgress: store.saveResearchChannelCollectionProgress,
    getMarketIntelligenceUnitsSpentSince: store.getMarketIntelligenceUnitsSpentSince,
    countMarketDiscoverySearchesSince: store.countMarketDiscoverySearchesSince,
    claimStaleResearchChannelsForCollection: store.claimStaleResearchChannelsForCollection,
    releaseResearchChannelCollectionClaim: store.releaseResearchChannelCollectionClaim,
    listRecentlyFailedResearchChannelIds: store.listRecentlyFailedResearchChannelIds,
    markResearchChannelAutoCollected: store.markResearchChannelAutoCollected,
    insertMarketIntelligenceCollectionRun: store.insertMarketIntelligenceCollectionRun,
    // Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md).
    getMarketDiscoveryCandidateById: store.getMarketDiscoveryCandidateById,
    listMarketDiscoveryCandidates: store.listMarketDiscoveryCandidates,
    insertMarketDiscoveryCandidate: store.insertMarketDiscoveryCandidate,
    touchMarketDiscoveryCandidateLastSeen: store.touchMarketDiscoveryCandidateLastSeen,
    setMarketDiscoveryCandidateStatus: store.setMarketDiscoveryCandidateStatus,
    insertMarketDiscoveryRun: store.insertMarketDiscoveryRun,
    // Phase 9 slice 9E (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md) -- topic model, part A.
    listMarketTopics: store.listMarketTopics,
    getMarketTopicById: store.getMarketTopicById,
    insertMarketTopic: store.insertMarketTopic,
    deleteMarketTopic: store.deleteMarketTopic,
    listAssignmentsForTopic: store.listAssignmentsForTopic,
    listTopicsForSubject: store.listTopicsForSubject,
    // Phase 9 slice 9H part C (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_C_PLAN.md).
    listMarketTopicAssignmentsBySubjectType: store.listMarketTopicAssignmentsBySubjectType,
    getTopicAssignment: store.getTopicAssignment,
    insertMarketTopicAssignment: store.insertMarketTopicAssignment,
    deleteMarketTopicAssignment: store.deleteMarketTopicAssignment,
    // Phase 9 slice 9E (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md) -- trend candidates, part B.
    listMarketTrendCandidates: store.listMarketTrendCandidates,
    getMarketTrendCandidateById: store.getMarketTrendCandidateById,
    insertMarketTrendCandidateWithInitialEvidence: store.insertMarketTrendCandidateWithInitialEvidence,
    updateMarketTrendCandidateStatusWithEvidence: store.updateMarketTrendCandidateStatusWithEvidence,
    touchMarketTrendCandidateLastObservedAt: store.touchMarketTrendCandidateLastObservedAt,
    listTrendEvidence: store.listTrendEvidence,
    insertMarketTrendEvidence: store.insertMarketTrendEvidence,
    // Phase 9 slice 9G, part A (docs/roadmap/plans/PHASE_9_SLICE_9G_PLAN.md).
    getLatestMarketIntelligenceCollectionRunForChannel: store.getLatestMarketIntelligenceCollectionRunForChannel,
    hasSuccessfulMarketIntelligenceCollectionRun: store.hasSuccessfulMarketIntelligenceCollectionRun,
    // Phase 9 slice 9G, part B (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md).
    insertMarketResearchRequest: store.insertMarketResearchRequest,
    getMarketResearchRequestById: store.getMarketResearchRequestById,
    listMarketResearchRequests: store.listMarketResearchRequests,
    approveMarketResearchRequestIfPending: store.approveMarketResearchRequestIfPending,
    rejectMarketResearchRequestIfPending: store.rejectMarketResearchRequestIfPending,
    recordMarketResearchRequestExecutionOutcome: store.recordMarketResearchRequestExecutionOutcome,
    // Agent-created collection requests (docs/decisions/0021-agent-collection-requests.md).
    insertMarketCollectionRequest: store.insertMarketCollectionRequest,
    getMarketCollectionRequestById: store.getMarketCollectionRequestById,
    listMarketCollectionRequests: store.listMarketCollectionRequests,
    findOpenMarketCollectionRequestForChannel: store.findOpenMarketCollectionRequestForChannel,
    approveMarketCollectionRequestIfPending: store.approveMarketCollectionRequestIfPending,
    startMarketCollectionRequestIfApproved: store.startMarketCollectionRequestIfApproved,
    rejectMarketCollectionRequestIfPending: store.rejectMarketCollectionRequestIfPending,
    finishMarketCollectionRequestIfRunning: store.finishMarketCollectionRequestIfRunning,
    failInterruptedMarketCollectionRequests: store.failInterruptedMarketCollectionRequests,
  });
  // BL-117: API calls made by Research collection / discovery are logged against it in the quota history.
  const guard = createQuotaGuardCore();
  const context = { kind: "research_collection", id: null, label: "Research collection" };
  return {
    ...services,
    // BL-117 (owner decision 2026-10-03): the AUTOMATIC refresh waits while less than the configured reserve of the daily quota
    // is left, so writes keep headroom (same rule as the Analytics auto-collection).
    runCollectionIfStale: quotaScoped(async (input: unknown) => {
      if (!(await guard.isBackgroundReadAllowed())) return { attempted: 0, succeeded: 0, failed: 0, quotaLimited: 0, unitsSpent: 0 };
      return services.runCollectionIfStale(input);
    }, context),
    // An approved collection request runs the regular collection for its own channels (same stale window, failed-channel pause and daily
    // budget). The background-reserve guard above is for the AUTOMATIC refresh; a person approving the request is the explicit trigger.
    runApprovedCollectionRequest: quotaScoped(services.runApprovedCollectionRequest, context),
    discoverChannels: quotaScoped(services.discoverChannels, context),
    captureChannelSnapshot: quotaScoped(services.captureChannelSnapshot, context),
    fetchPublicSnapshot: quotaScoped(services.fetchPublicSnapshot, context),
  };
}

export type MarketIntelligenceCore = ReturnType<typeof createMarketIntelligenceCore>;
export type {
  ResearchChannel,
  ResearchEvidence,
  MarketChannelSnapshot,
  MarketVideoSnapshot,
  MarketDiscoveryCandidate,
  MarketTopic,
  MarketTopicAssignment,
  MarketTrendCandidate,
  MarketTrendEvidence,
  MarketResearchRequest,
  MarketCollectionRequest,
} from "./contracts";
export { DomainError, isDomainError } from "./contracts";
