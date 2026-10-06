import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { getMcpConnectionEnabled, rawSqlClient, recordGatewayCallOutcome } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { createFactoryMcpEndpoint } from "@/lib/factory-mcp-endpoint";
import { createFactoryTokenCore } from "@/lib/factory-agent-tokens";
import { createLogicalPathsCore } from "@/lib/logical-paths";
import { createMediaGenerationCore, DomainError } from "@/lib/media-generation";
import { createFactoryMcpServer, type FactoryToolDeps } from "@/mcp/factory-server";

// Never cached or prerendered: every call is an authenticated, per-request Factory Operator session.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Factory Operator access (docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md F3). Wiring only: which
// modules the factory tools may reach is pinned by `src/mcp/factory-server.test.ts`. This route never
// imports a YouTube gateway, analytics, change sets, batches, or channel-scope state.
function createToolDeps(): FactoryToolDeps {
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
    // BL-132 (FACTORY_MEDIA_CONTROL_PLAN.md §2.6): the media core of THIS server process (the same instance the watch loop
    // uses, so pulls stay serialized); every write passes actor `factory`. No session or job action is wired (D4).
    media: {
      storageStatus: async () => ({ storage: await createMediaGenerationCore().storageStatus() }),
      listModels: async () => createMediaGenerationCore().listModelsWithUsage(),
      pullModel: async (input) => ({ pull: await createMediaGenerationCore().startPull(input, { requestedBy: "factory" }) }),
      getPull: async ({ pullId }) => {
        const pulls = await createMediaGenerationCore().listPulls();
        if (pullId === undefined) return { pulls: [...pulls].reverse().slice(0, 20) };
        const pull = pulls.find((p) => p.pullId === pullId);
        if (!pull) throw new DomainError({ code: "media_job_not_found", message: "No model pull with this id", details: { pullId } });
        return { pull };
      },
      cancelPull: async (input) => ({ pull: await createMediaGenerationCore().cancelPull(input, { actor: "factory" }) }),
      deleteModel: async (input) => createMediaGenerationCore().deleteModel(input, { actor: "factory" }),
      listTemplates: async () => {
        const core = createMediaGenerationCore();
        const [templates, lastSync, onVolume] = await Promise.all([
          core.listWorkflowTemplates(),
          core.getLastTemplateSync(),
          // The volume listing is S3; when it fails the templates are still listed, with modelsMissing unknown (null).
          core.listModels().then((models) => new Set(models.map((m) => m.key)), () => null),
        ]);
        return {
          templates: templates.map((t) => ({
            templateId: t.templateId,
            version: t.version,
            source: t.source,
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            models: t.models,
            modelsMissing: onVolume === null ? null : t.models.filter((m) => m.folder && !onVolume.has(`models/${m.folder}/${m.file}`)),
            updatedAt: t.updatedAt,
          })),
          lastSync,
        };
      },
      syncTemplates: async ({ dryRun }) => ({ result: await createMediaGenerationCore().syncTemplatesFromRegistry({ trigger: "factory", dryRun }) }),
    },
    assertMutationAllowed: () => assertDeviceAvailableForMutation(rawSqlClient),
  };
}

const endpoint = createFactoryMcpEndpoint({
  isConnectionEnabled: getMcpConnectionEnabled,
  verifyToken: (token) => createFactoryTokenCore().verifyToken(token),
  createServer: ({ session }) => createFactoryMcpServer(createToolDeps(), { connectionEnabled: true, session }),
});

// Stateless Streamable HTTP: only POST is meaningful. GET/DELETE get the endpoint's own explicit 405
// (after the same loopback check), never Next's generic one.
export const POST = endpoint.handle;
export const GET = endpoint.handle;
export const DELETE = endpoint.handle;
