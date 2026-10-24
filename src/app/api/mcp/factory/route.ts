import { createFactoryMcpEndpoint } from "@/lib/factory-mcp-endpoint";
import { createFactoryTokenCore } from "@/lib/factory-agent-tokens";
import { createFactoryMcpServer } from "@/mcp/factory-server";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { getMcpConnectionEnabled, rawSqlClient, recordGatewayCallOutcome } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { createLogicalPathsCore } from "@/lib/logical-paths";
import { createGenerationPlansCore, withPlanLock } from "@/lib/generation-plans";
import { createMediaGenerationCore, DomainError, withJobErrorCode } from "@/lib/media-generation";
import type { FactoryToolDeps } from "@/mcp/factory-server";
import { createFactoryChannelDeps } from "@/mcp/factory-channel-deps";

// Factory Operator access (docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md F3). Wiring only (the channel part is shared with the
// channel workers in src/mcp/factory-channel-deps.ts, BL-217): which
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
      // FO-REQ-0005.
      deleteTemplate: async (input) => createMediaGenerationCore().deleteWorkflowTemplate(input, { actor: "factory" }),
      adoptTemplate: async (input) => createMediaGenerationCore().adoptWorkflowTemplate(input),
      getSettings: async () => {
        const core = createMediaGenerationCore();
        const [settings, hf] = await Promise.all([core.getFactorySettings(), core.getHfToken()]);
        // BL-134 (FO-REQ-0028 E): whether a Hugging Face token is stored and readable here -- never the value.
        return { settings: { ...settings, hfToken: hf.state === "set" ? ("set" as const) : ("not set" as const) } };
      },
      // BL-200: pod runtime profiles (every write recorded with actor `factory`).
      listRuntimes: async () => createMediaGenerationCore().listRuntimes(),
      getRuntime: async ({ runtimeId }) => {
        const core = createMediaGenerationCore();
        const [runtime, builds, tests] = await Promise.all([core.getRuntime(runtimeId), core.listRuntimeBuilds(), core.listRuntimeTests(runtimeId)]);
        return { runtime, builds: builds.filter((b) => b.runtimeId === runtimeId).slice(-10), tests: tests.slice(-10) };
      },
      listComfyReleases: async () => createMediaGenerationCore().listComfyReleases(),
      createRuntime: async (input) => createMediaGenerationCore().createRuntime(input, { actor: "factory" }),
      testRuntime: async ({ runtimeId, templateIds, channelId }) => {
        const connected = await channelConnections.listConnectedChannels();
        const channel = channelId ?? connected[0]?.channelId;
        if (!channel || !connected.some((c) => c.channelId === channel)) {
          throw new DomainError({ code: "CHANNEL_WORKSPACE_CHANNEL_NOT_CONNECTED", message: "No connected channel with this id; the test session is booked to a connected channel.", details: { channelId: channel ?? null } });
        }
        return { test: await createMediaGenerationCore().testRuntime({ runtimeId, channelId: channel, ...(templateIds ? { templateIds } : {}) }, { actor: "factory" }) };
      },
      setActiveRuntime: async ({ runtimeId }) => createMediaGenerationCore().setActiveRuntime({ runtimeId }, { actor: "factory" }),
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
            // BL-159: which installed version carries a minimum host CUDA (RISK-116: an older build keeps an older copy).
            minCudaVersion: t.minCudaVersion,
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
        // BL-159: the template's own minimum host CUDA (the call's, if given, wins in factoryStartSession).
        let templateMinCudaVersion: string | null = null;
        if (input.templateId) {
          const template = (await core.listWorkflowTemplates()).find((t) => t.templateId === input.templateId);
          if (!template) throw new DomainError({ code: "media_template_not_found", message: "No workflow template with this id", details: { templateId: input.templateId } });
          if (!gpu) gpu = template.gpu ?? undefined;
          templateMinCudaVersion = template.minCudaVersion ?? null;
          // BL-200 (AC-RT-07): a template the session's runtime cannot load is refused before any pod.
          await core.assertTemplateFitsRuntime({ templateId: input.templateId, ...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}) });
        }
        // BL-143: a session for a plan -- the plan must be active and of this channel.
        if (input.planId) await createGenerationPlansCore().checkSessionLink({ planId: input.planId, channelId: input.channelId });
        return core.factoryStartSession({
          channelId: input.channelId,
          ...(input.planId ? { planId: input.planId } : {}),
          ...(input.maxMinutes !== undefined ? { maxMinutes: input.maxMinutes } : {}),
          ...(input.maxUsd !== undefined ? { maxUsd: input.maxUsd } : {}),
          ...(gpu ? { gpu } : {}),
          ...(input.releaseWhenDone !== undefined ? { releaseWhenDone: input.releaseWhenDone } : {}),
          ...(input.minCudaVersion ? { minCudaVersion: input.minCudaVersion } : {}),
          ...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}),
          templateMinCudaVersion,
        });
      },
      getSession: async ({ sessionId }) => {
        const core = createMediaGenerationCore();
        if (sessionId === undefined) return { sessions: (await core.listSessions(100)).filter((s) => s.requestedBy === "factory").slice(0, 20) };
        return { session: await factorySession(sessionId) };
      },
      endSession: async ({ sessionId }) => ({ session: await createMediaGenerationCore().factoryStopSession({ sessionId }) }),
      createJob: async ({ sessionId, templateId, params, planId, itemKey, seed, storyboardId, segmentId, videoNumber }) => {
        const session = await factorySession(sessionId);
        // BL-143: a job that names a plan attempt -- all checked by the plans module before the job exists.
        if ((planId === undefined) !== (itemKey === undefined)) throw new DomainError({ code: "validation_failed", message: "Give planId and itemKey together (seed is optional)." });
        // BL-184 stage 2: the storyboard segment it renders -- checked by the media module's storyboard gate.
        if ((storyboardId === undefined) !== (segmentId === undefined)) throw new DomainError({ code: "validation_failed", message: "Give storyboardId and segmentId together." });
        const storyboard = storyboardId && segmentId ? { storyboard: { storyboardId, segmentId } } : {};
        const create = async () => {
          const plan = planId && itemKey ? await createGenerationPlansCore().checkJobLink({ planId, itemKey, seed: seed ?? null, sessionId, channelId: session.channelId }) : undefined;
          return { job: withJobErrorCode(await createMediaGenerationCore().createJob({ sessionId, channelId: session.channelId, templateId, params, createdBy: "factory", ...(plan ? { plan } : {}), ...storyboard, ...(videoNumber !== undefined ? { videoNumber } : {}) })) };
        };
        // BL-157 (review round 2): a plan-linked job is checked and created under the plan's lock, so a plan move cannot
        // pass between them and leave the moved plan with a job still running on the old channel.
        // Locked on the id the plans module will use (it trims it) -- review round 3.
        return planId && itemKey ? withPlanLock(planId.trim(), create) : create();
      },
      getJob: async ({ jobId, sessionId }) => {
        const core = createMediaGenerationCore();
        if (jobId !== undefined) {
          const job = await core.getJob({ jobId });
          await factorySession(job.sessionId, () => new DomainError({ code: "media_job_not_found", message: "No job with this id", details: { jobId } }));
          // BL-155 (Factory API 1.7.0): errorCode derived from the job's error text.
          return { job: withJobErrorCode(job) };
        }
        if (sessionId === undefined) throw new DomainError({ code: "validation_failed", message: "Give a jobId, or a sessionId to list its jobs." });
        await factorySession(sessionId);
        return { jobs: (await core.listJobs({ sessionId })).map(withJobErrorCode) };
      },
      cancelJob: async ({ jobId }) => {
        const core = createMediaGenerationCore();
        const job = await core.getJob({ jobId });
        await factorySession(job.sessionId, () => new DomainError({ code: "media_job_not_found", message: "No job with this id", details: { jobId } }));
        return { job: withJobErrorCode(await core.cancelJob({ jobId })) };
      },
      capacityLog: async ({ since, gpuTypeId, limit }) => ({
        attempts: await createMediaGenerationCore().listCapacityAttempts({ ...(since ? { since: new Date(since) } : {}), ...(gpuTypeId ? { gpuTypeId } : {}), ...(limit ? { limit } : {}) }),
      }),
      // BL-172 (FO-REQ-0016 A): the media core validates the input again and reads the catalog through the media gateway.
      gpuAvailability: async (input) => ({ availability: await createMediaGenerationCore().getGpuAvailability(input) }),
      gpuAvailabilityLog: async (input) => ({ log: await createMediaGenerationCore().listGpuAvailabilityLog(input) }),
      // BL-206 (FO-REQ-0033): local statistics; the media core validates again and refuses from > to or > 90 days.
      gpuStats: async (input) => ({ stats: await createMediaGenerationCore().getGpuStats(input) }),
    },
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
