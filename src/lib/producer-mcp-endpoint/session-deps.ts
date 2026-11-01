import type { ProducerSession } from "@/mcp/server";
import { runInAgentSession } from "@/lib/agent-session";
import { MILESTONE_DAYS, hasFinalPublishDate, isMilestoneDue, milestoneWindow } from "@/lib/analytics";
import { createAgentProposalSubmitCore } from "@/lib/agent-proposals";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import {
  getLatestChannelMetricCollectedAt,
  getStoredChannel,
  insertProducerCallLogEntry,
  listChannelMetricsInRange,
  listStoredVideosByChannel,
  listVideoMilestoneTotals,
} from "@/lib/db";
import { createPortfolioOverviewServices, createUploadMilestonesServices } from "@/lib/portfolio-overview";
import { createReachReportsCore } from "@/lib/reach-reports";
import { PRODUCER_API_VERSION } from "@/mcp/producer-tools";
import { createLiveAnalyticsCore } from "@/lib/live-analytics";
import { createUploadQueueControlCore, type SlotDecision } from "@/lib/publishing";
import type { ProducerMcpSession } from "./index";

// BL-161 / BL-166: the real deps of a Producer session -- what `src/app/api/mcp/producer/route.ts` hands the MCP server. Kept here,
// not in the route file (a route may only export its handlers), so the wiring is tested on a real database
// (`session-deps.test.ts`), not only through fakes.

/** Every channel in Settings → Channels on this device, with this device's workspace folder (or null). */
async function listChannels(): Promise<Array<{ channelId: string; title: string; workspace: string | null }>> {
  const [connected, workspaces] = await Promise.all([createChannelConnectionsCore().listConnectedChannels(), createChannelWorkspacesCore().listWorkspaces()]);
  const pathByChannel = new Map(workspaces.map((entry) => [entry.channelId, entry.path]));
  return connected.map((channel) => ({ channelId: channel.channelId, title: channel.title, workspace: pathByChannel.get(channel.channelId) ?? null }));
}

/** The Google account a channel is connected under here -- only for a channel Settings → Channels lists as connected. */
async function resolveChannelUser(channelId: string): Promise<string | null> {
  const connected = (await createChannelConnectionsCore().listConnectedChannels()).some((channel) => channel.channelId === channelId);
  return connected ? ((await getStoredChannel(channelId))?.connectedUserId ?? null) : null;
}

/**
 * `slotDecisions` (BL-239): the weekly plan's slot decisions, from the composition layer (the Producer route passes them), so an
 * upload the Producer adds gets a date only from a slot the owner approved, and a vetoed slot is refused.
 */
export function createProducerSessionDeps(
  session: ProducerMcpSession,
  options: { slotDecisions?: (channelId: string) => Promise<Map<string, SlotDecision>> } = {}
): ProducerSession {
  const portfolio = createPortfolioOverviewServices({
    listChannels,
    async loadChannel(channel, range) {
      const userId = await resolveChannelUser(channel.channelId);
      const reach = userId
        ? await runInAgentSession({ tokenId: session.tokenId, channelId: channel.channelId, userId }, () =>
            createReachReportsCore().getChannelReach({ credentialRef: { userId }, channelId: channel.channelId, startDate: range.startDate, endDate: range.endDate })
          ).catch(() => null)
        : null;
      const [metrics, videos, stored, lastAnalyticsCollectedAt] = await Promise.all([
        listChannelMetricsInRange(channel.channelId, range),
        listStoredVideosByChannel(channel.channelId),
        getStoredChannel(channel.channelId),
        getLatestChannelMetricCollectedAt(channel.channelId),
      ]);
      return {
        channelId: channel.channelId,
        title: channel.title,
        metrics,
        reach: reach
          ? { state: reach.state, impressions: reach.totals.impressions, ctr: reach.totals.ctr, coveredThrough: reach.coverage.lastDate, daysWithData: reach.daily.length }
          : null,
        videoPublishedAt: videos.map((video) => video.publishedAt),
        lastVideoSyncAt: stored?.lastSyncedAt ?? null,
        lastAnalyticsCollectedAt,
      };
    },
  });
  // BL-166: each channel's uploads with their stored day-7 / day-28 milestones, and Reach over each window -- read inside the channel's
  // agent scope, like the portfolio's Reach, so it passes the same channel check as the channel's own agent.
  const uploadMilestones = createUploadMilestonesServices({
    milestoneDays: MILESTONE_DAYS,
    windowOf: milestoneWindow,
    isDue: (windowEnd) => isMilestoneDue(windowEnd, new Date()),
    isPublished: (video) => hasFinalPublishDate({ videoId: "", ...video }),
    listChannels,
    async listVideos(channelId) {
      const stored = await getStoredChannel(channelId);
      if (!stored?.lastSyncedAt) return null;
      return (await listStoredVideosByChannel(channelId)).map((video) => ({
        videoId: video.videoId,
        title: video.title,
        publishedAt: video.publishedAt ?? null,
        privacyStatus: video.privacyStatus ?? null,
        liveBroadcastContent: video.liveBroadcastContent ?? null,
        durationSeconds: video.durationSeconds ?? null,
      }));
    },
    listStoredMilestones: (channelId, videoIds) => listVideoMilestoneTotals(channelId, videoIds),
    async readReach(channelId, windows) {
      const userId = await resolveChannelUser(channelId);
      if (!userId) return null;
      return runInAgentSession({ tokenId: session.tokenId, channelId, userId }, () =>
        createReachReportsCore().getVideoWindowsReach({ credentialRef: { userId }, channelId, windows })
      );
    },
  });
  // BL-163: the Producer's side of the proposal store only; approving and applying are Web-UI routes.
  const proposals = createAgentProposalSubmitCore();
  // BL-239 (ADR 0059, owner msgs 3928/3930): this computer's upload queue -- the only wiring of the queue control to an MCP
  // endpoint (no-agent-upload-tool.test.ts). "Connected here" is the Producer's own rule (Settings → Channels).
  const queue = () => createUploadQueueControlCore({ channelUser: resolveChannelUser, ...(options.slotDecisions ? { slotDecisions: options.slotDecisions } : {}) });
  const producer = { kind: "producer" as const, tokenId: session.tokenId };
  return {
    tokenId: session.tokenId,
    reverify: () => session.reverify(),
    resolveChannelUser,
    async recordCall(entry) {
      session.noteRecorded(entry.tool, entry.channelId);
      await insertProducerCallLogEntry({ at: new Date(), ...entry });
    },
    listChannels,
    portfolioOverview: async (input) => ({ ...(await portfolio.getOverview(input)) }),
    uploadMilestones: async (input) => ({ ...(await uploadMilestones.getUploadMilestones(input)) }),
    liveAnalytics: async (input) => ({ ...(await createLiveAnalyticsCore().portfolio(input, await listChannels())) }),
    proposals: {
      submit: async (input) => ({ ...(await proposals.submitProducerProposal(input, { agentApiVersion: PRODUCER_API_VERSION })) }),
      list: async (input) => ({ ...(await proposals.listProducerProposals(input)) }),
      markDone: async (input) => ({ ...(await proposals.markProducerProposalsDone(input)) }),
    },
    uploadQueue: {
      list: async () => ({ ...(await queue().list()) }),
      add: async (input) => ({ ...(await queue().add(input, producer)) }),
      move: async (input) => ({ ...(await queue().move(input, producer)) }),
      cancel: async (input) => ({ ...(await queue().cancel(input, producer)) }),
    },
  };
}
