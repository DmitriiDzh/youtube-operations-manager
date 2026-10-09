import { runInAgentSession } from "@/lib/agent-session";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import {
  getLatestChannelMetricCollectedAt,
  getMcpConnectionEnabled,
  getStoredChannel,
  insertProducerCallLogEntry,
  listChannelMetricsInRange,
  listStoredVideosByChannel,
  recordGatewayCallOutcome,
} from "@/lib/db";
import { createPortfolioOverviewServices } from "@/lib/portfolio-overview";
import { createProducerTokenCore } from "@/lib/producer-agent-tokens";
import { createProducerMcpEndpoint } from "@/lib/producer-mcp-endpoint";
import { createReachReportsCore } from "@/lib/reach-reports";
import { PRODUCER_TOOL_NAMES } from "@/mcp/producer-tools";
import { createMcpServer, type ProducerSession } from "@/mcp/server";

// Never cached or prerendered: every call is an authenticated, per-request Producer session.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-161 (docs/roadmap/plans/PRODUCER_ROLE_PLAN.md §3). Wiring only: which tools the Producer gets is the closed list in
// `src/mcp/producer-tools.ts`; each channel tool runs in the named channel's agent scope (`createMcpServer`'s producer mode).

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

function createProducerSessionDeps(session: { tokenId: string; reverify(): Promise<void>; noteRecorded(tool: string): void }): ProducerSession {
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
  return {
    tokenId: session.tokenId,
    reverify: () => session.reverify(),
    resolveChannelUser,
    async recordCall(entry) {
      session.noteRecorded(entry.tool);
      await insertProducerCallLogEntry({ at: new Date(), ...entry });
    },
    listChannels,
    portfolioOverview: async (input) => ({ ...(await portfolio.getOverview(input)) }),
  };
}

const endpoint = createProducerMcpEndpoint({
  isConnectionEnabled: getMcpConnectionEnabled,
  verifyToken: (token) => createProducerTokenCore().verifyToken(token),
  createServer: ({ session }) => createMcpServer(undefined, { connectionEnabled: true, producerSession: createProducerSessionDeps(session) }),
  isProducerTool: (name) => PRODUCER_TOOL_NAMES.includes(name),
  async recordRefusedCall(call) {
    await recordGatewayCallOutcome("mcp_tool_calls", "blocked");
    await insertProducerCallLogEntry({ at: new Date(), tool: call.tool, channelId: call.channelId, outcome: "error", errorCode: call.errorCode });
  },
});

// Stateless Streamable HTTP: only POST is meaningful. GET/DELETE get the endpoint's own explicit 405
// (after the same loopback check), never Next's generic one.
export const POST = endpoint.handle;
export const GET = endpoint.handle;
export const DELETE = endpoint.handle;
