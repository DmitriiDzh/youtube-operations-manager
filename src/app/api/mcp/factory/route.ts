import { createFactoryMcpEndpoint } from "@/lib/factory-mcp-endpoint";
import { createFactoryTokenCore } from "@/lib/factory-agent-tokens";
import { createFactoryMcpServer } from "@/mcp/factory-server";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { getMcpConnectionEnabled, rawSqlClient, recordGatewayCallOutcome } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { createLogicalPathsCore } from "@/lib/logical-paths";
import type { FactoryToolDeps } from "@/mcp/factory-server";
import { createFactoryChannelDeps } from "@/mcp/factory-channel-deps";
import { createFactoryMediaDeps } from "../factory-media-deps";

// Factory Operator access (docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md F3). Wiring only (the channel part is shared with the
// channel workers in src/mcp/factory-channel-deps.ts, BL-217): which
// modules the factory tools may reach is pinned by `src/mcp/factory-server.test.ts`. This route never
// imports a YouTube gateway, analytics, change sets, batches, or channel-scope state.

function createFactoryToolDeps(): FactoryToolDeps {
  const logicalPaths = createLogicalPathsCore();
  const channelConnections = createChannelConnectionsCore();
  const channelWorkspaces = createChannelWorkspacesCore();
  return {
    readLogicalPath: (input) => logicalPaths.readPath(input, "factory"),
    listLogicalPaths: () => logicalPaths.listReadable("factory"),
    // Only these keys leave the app: never `connectedEmail`, `connectedAt`, `thumbnailUrl` or any user id.
    listChannels: async () => {
      const [connected, workspaces] = await Promise.all([
        channelConnections.listConnectedChannels(),
        channelWorkspaces.listWorkspaces(),
      ]);
      const pathByChannel = new Map(workspaces.map((entry) => [entry.channelId, entry.path]));
      return connected.map((channel) => {
        const path = pathByChannel.get(channel.channelId);
        return {
          channelId: channel.channelId,
          title: channel.title,
          workspace: path ? { configured: true as const, path } : { configured: false as const },
        };
      });
    },
    recordOutcome: (outcome) => recordGatewayCallOutcome("mcp_tool_calls", outcome),
    // BL-132 / BL-133: the media core's factory-facing actions, shared with the channel workers (BL-218, ./factory-media-deps.ts).
    media: createFactoryMediaDeps(),
    ...createFactoryChannelDeps(),
    assertMutationAllowed: () => assertDeviceAvailableForMutation(rawSqlClient),
  };
}


// Never cached or prerendered: every call is an authenticated, per-request Factory Operator session.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const endpoint = createFactoryMcpEndpoint({
  isConnectionEnabled: getMcpConnectionEnabled,
  verifyToken: (token) => createFactoryTokenCore().verifyToken(token),
  createServer: ({ session }) => createFactoryMcpServer(createFactoryToolDeps(), { connectionEnabled: true, session }),
});

// Stateless Streamable HTTP: only POST is meaningful. GET/DELETE get the endpoint's own explicit 405
// (after the same loopback check), never Next's generic one.
export const POST = endpoint.handle;
export const GET = endpoint.handle;
export const DELETE = endpoint.handle;
