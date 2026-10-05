import { getAgentSession } from "@/lib/agent-session";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import type { MarketRecordKind } from "./contracts";
import { createMarketAssignmentStore } from "./adapters/store";
import { createMarketAssignmentServices } from "./services";

/**
 * Phase 12 slice 12.4. Record existence is checked through market-intelligence's own public core
 * (never its db.ts internals, PHASE9-INV-02).
 */
export function createMarketAssignmentCore() {
  const marketIntelligence = createMarketIntelligenceCore();
  const channelConnections = createChannelConnectionsCore();
  return createMarketAssignmentServices({
    store: createMarketAssignmentStore(),
    getAgentBoundChannelId: () => getAgentSession()?.channelId ?? null,
    listConnectedChannelIds: async () => (await channelConnections.listConnectedChannels()).map((channel) => channel.channelId),
    async recordExists(recordKind: MarketRecordKind, recordId: string) {
      switch (recordKind) {
        case "research_channel":
          return (await marketIntelligence.listWatchlist()).channels.some((c) => c.channelId === recordId);
        case "discovery_candidate":
          return (await marketIntelligence.listDiscoveryCandidates()).candidates.some((c) => c.channelId === recordId);
        case "topic":
          return (await marketIntelligence.listTopics()).topics.some((t) => t.topicId === recordId);
        case "trend_candidate":
          return (await marketIntelligence.listTrendCandidates()).trendCandidates.some((t) => t.trendCandidateId === recordId);
        case "research_request":
          return (await marketIntelligence.listResearchRequests()).requests.some((r) => r.requestId === recordId);
        case "collection_request":
          return (await marketIntelligence.listCollectionRequests()).requests.some((r) => r.requestId === recordId);
      }
    },
  });
}

export type MarketAssignmentCore = ReturnType<typeof createMarketAssignmentCore>;
export { MARKET_RECORD_KINDS, type MarketRecordKind, type MarketAssignmentView } from "./contracts";
