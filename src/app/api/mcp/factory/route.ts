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
/** BL-133: a session the Factory Operator started -- anything else is reported as not found. */
async function factorySession(sessionId: string, notFound?: () => DomainError) {
  try {
    return await createMediaGenerationCore().getFactorySession({ sessionId });
  } catch (error) {
    throw notFound?.() ?? error;
  }
}

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
      // BL-133 (FACTORY_GPU_SESSIONS_PLAN.md §2.2): sessions the factory starts within the owner's factory limits, and jobs
      // only in THOSE sessions -- another session (a channel's, the owner's) behaves like one that does not exist.
      startSession: async (input) => {
        const core = createMediaGenerationCore();
        const connected = await channelConnections.listConnectedChannels();
        if (!connected.some((c) => c.channelId === input.channelId)) {
          throw new DomainError({ code: "CHANNEL_WORKSPACE_CHANNEL_NOT_CONNECTED", message: "No connected channel with this id; outputs go to a connected channel's workspace.", details: { channelId: input.channelId } });
        }
        let gpu = input.gpu;
        if (!gpu && input.templateId) {
          const template = (await core.listWorkflowTemplates()).find((t) => t.templateId === input.templateId);
          if (!template) throw new DomainError({ code: "media_template_not_found", message: "No workflow template with this id", details: { templateId: input.templateId } });
          gpu = template.gpu ?? undefined;
        }
        return core.factoryStartSession({
          channelId: input.channelId,
          ...(input.maxMinutes !== undefined ? { maxMinutes: input.maxMinutes } : {}),
          ...(input.maxUsd !== undefined ? { maxUsd: input.maxUsd } : {}),
          ...(gpu ? { gpu } : {}),
          ...(input.releaseWhenDone !== undefined ? { releaseWhenDone: input.releaseWhenDone } : {}),
        });
      },
      getSession: async ({ sessionId }) => {
        const core = createMediaGenerationCore();
        if (sessionId === undefined) return { sessions: (await core.listSessions(100)).filter((s) => s.requestedBy === "factory").slice(0, 20) };
        return { session: await factorySession(sessionId) };
      },
      endSession: async ({ sessionId }) => ({ session: await createMediaGenerationCore().factoryStopSession({ sessionId }) }),
      createJob: async ({ sessionId, templateId, params }) => {
        const session = await factorySession(sessionId);
        return { job: await createMediaGenerationCore().createJob({ sessionId, channelId: session.channelId, templateId, params, createdBy: "factory" }) };
      },
      getJob: async ({ jobId, sessionId }) => {
        const core = createMediaGenerationCore();
        if (jobId !== undefined) {
          const job = await core.getJob({ jobId });
          await factorySession(job.sessionId, () => new DomainError({ code: "media_job_not_found", message: "No job with this id", details: { jobId } }));
          return { job };
        }
        if (sessionId === undefined) throw new DomainError({ code: "validation_failed", message: "Give a jobId, or a sessionId to list its jobs." });
        await factorySession(sessionId);
        return { jobs: await core.listJobs({ sessionId }) };
      },
      cancelJob: async ({ jobId }) => {
        const core = createMediaGenerationCore();
        const job = await core.getJob({ jobId });
        await factorySession(job.sessionId, () => new DomainError({ code: "media_job_not_found", message: "No job with this id", details: { jobId } }));
        return { job: await core.cancelJob({ jobId }) };
      },
      capacityLog: async ({ since, gpuTypeId, limit }) => ({
        attempts: await createMediaGenerationCore().listCapacityAttempts({ ...(since ? { since: new Date(since) } : {}), ...(gpuTypeId ? { gpuTypeId } : {}), ...(limit ? { limit } : {}) }),
      }),
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
