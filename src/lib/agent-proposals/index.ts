import { createChannelAccessCore } from "@/lib/channel-access";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createDecisionEngineCore } from "@/lib/decision-engine";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { rawSqlClient } from "@/lib/db";
import { createMarketAssignmentCore } from "@/lib/market-assignments";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { isDomainError } from "./contracts";
import { createAgentProposalStore } from "./adapters/store";
import { createAgentProposalServices } from "./services";

/** Every service; split below into the Producer's part and the owner's part, so each caller gets only its own. */
function createAgentProposalsCore() {
  const marketIntelligence = createMarketIntelligenceCore();
  const assignments = createMarketAssignmentCore();
  const decisions = createDecisionEngineCore();
  const channelAccess = createChannelAccessCore();
  const channelConnections = createChannelConnectionsCore();
  const followersOf = async (researchChannelId: string) =>
    (await assignments.listAssignments({ recordKind: "research_channel" })).find((entry) => entry.recordId === researchChannelId)?.channelIds ?? [];
  return createAgentProposalServices({
    idGenerator: () => crypto.randomUUID(),
    clock: { now: () => new Date() },
    store: createAgentProposalStore(),
    listConnectedChannels: async () => (await channelConnections.listConnectedChannels()).map((channel) => ({ channelId: channel.channelId, title: channel.title })),
    assertDeviceAvailable: () => assertDeviceAvailableForMutation(rawSqlClient),
    watchlist: {
      async getEntry(researchChannelId) {
        try {
          const entry = await marketIntelligence.getWatchlistEntry({ channelId: researchChannelId });
          return { channelId: entry.channelId, handleOrUrl: entry.handleOrUrl ?? null, pausedAt: entry.pausedAt };
        } catch (error) {
          if (isDomainError(error) && (error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE" || error.code === "validation_failed")) return null;
          throw error;
        }
      },
      followers: followersOf,
      async add(input) {
        await marketIntelligence.addToWatchlist(input, { createdVia: "mcp" });
      },
      async setFollowers(researchChannelId, channelIds) {
        await assignments.setAssignment({ recordKind: "research_channel", recordId: researchChannelId, channelIds });
      },
      async setPause(researchChannelId, paused) {
        await marketIntelligence.setWatchlistPause({ channelId: researchChannelId, paused });
      },
      async remove(researchChannelId) {
        await marketIntelligence.removeFromWatchlist({ channelId: researchChannelId });
      },
      async describe() {
        const { channels } = await marketIntelligence.listWatchlist();
        return new Map(channels.map((channel) => [channel.channelId, { label: channel.handleOrUrl ?? channel.channelId, latestUploadPublishedAt: channel.latestUploadPublishedAt }]));
      },
    },
    hypotheses: {
      async add(input, ctx) {
        // On the owner's approval, as the owner's own session; the Producer is named as the author.
        await decisions.createHypothesis(input, { userId: ctx.userId, createdBy: "producer", createdVia: "mcp" });
      },
      activeChannelOf: (userId) => channelAccess.getActiveChannelId(userId),
    },
  });
}

/** The Producer's part (its MCP tools): submit, list its own, mark read. It cannot approve, reject or apply (AC-PR-05). */
export function createAgentProposalSubmitCore() {
  const core = createAgentProposalsCore();
  return {
    submitProducerProposal: core.submitProducerProposal,
    listProducerProposals: core.listProducerProposals,
    markProducerProposalsDone: core.markProducerProposalsDone,
  };
}

/** The owner's part: Web UI routes only (never MCP, CLI or agent-operations -- the inventory test enforces it). */
export function createAgentProposalReviewCore() {
  const core = createAgentProposalsCore();
  return {
    listOwnerProposals: core.listOwnerProposals,
    countPendingProposals: core.countPendingProposals,
    approveAgentProposal: core.approveAgentProposal,
    rejectAgentProposal: core.rejectAgentProposal,
  };
}

export { AGENT_PROPOSAL_KINDS, AGENT_PROPOSAL_KEEP_DAYS, type AgentProposal, type OwnerAgentProposal } from "./contracts";
