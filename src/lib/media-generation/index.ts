import { getDeviceSecrets } from "@/lib/device-secrets";
import { createHfTokenServices } from "./hf-token";
import { createRuntimeServices } from "./runtimes";
import { createRuntimeBuildServices } from "./runtime-builds";
import { createRuntimeTestServices } from "./runtime-tests";
import { assertActiveRuntimeUnchanged, runtimeIncompatibleError, templateRuntimeProblems } from "./runtimes";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createAssetCatalogCore } from "@/lib/asset-catalog";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { appDataPaths, countMediaGpuAvailabilityCells, getLatestMediaGpuAvailabilityAt, listMediaSessionsNeedingCostSplit, setMediaJobCostShare, getMediaSessionJobSummary, insertMediaCapacityAttempt, insertMediaGpuAvailabilitySnapshot, listMediaCapacityAttempts, listMediaGpuAvailabilityLog, setMediaCapacityAttemptHostCuda, setMediaCapacityAttemptTimings, summarizeMediaGpuAvailabilityLog, getMediaTemplateAdoptionsJson, getMediaTemplateSyncLastJson, listMediaControlEvents, setMediaTemplateAdoptionsJson, setMediaTemplateSyncLastJson } from "@/lib/db";
import { createLogicalPathsCore } from "@/lib/logical-paths";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { comfyUiProxyBaseUrl, createComfyUiClient, createGithubClient, createHuggingFaceClient, createRunpodApiClient, createRunpodS3Client } from "@/lib/media-gateway";
import { sleep as sharedSleep } from "@/lib/shared-async";
import { createExchangeFs, resolveFromYtmDir, resolveSentToYtmFile } from "@/lib/workspace-exchange";
import { createExchangeLocalFs } from "./adapters/exchange-fs";
import { createMediaJobStore } from "./adapters/job-store";
import { createMediaSessionStore, listSessionsFirstApprovedBetween } from "./adapters/session-store";
import { createTemplateRegistryReader } from "./adapters/template-registry-fs";
import { createMediaControlEventSink, createMediaGenerationStore, createModelPullStore, createRuntimeBuildStore, createRuntimeTestStore, createVolumeLockStore } from "./adapters/store";
import { DomainError, MEDIA_SESSION_TERMINAL_STATUSES, type MediaCapacityAttempt, type MediaControlEventView, type MediaModelUsage } from "./contracts";
import { createJobProgressRegistry } from "./job-progress";
import { splitEndedSessionCosts } from "./cost-split";
import { createMediaJobServices } from "./jobs";
import { createMediaModelServices } from "./models";
import { findLivePodByName } from "./pod-lifecycle";
import { createGpuAvailabilityLogServices } from "./gpu-availability-log";
import { createGpuStatsServices } from "./gpu-stats";
import { createMediaGenerationServices } from "./services";
import { comfyVersionOf, createMediaSessionServices } from "./sessions";
import { createVolumeLock } from "./volume-lock";
import { createVolumeMigrationServices } from "./volume-migration";
import { accountWideUsage, buildSessionsReport, deriveOtherDevices, stopPeerSession, type OtherDevicesView, type SessionJobsInput } from "./cross-device";
import { podNameFor } from "./sessions";
import { createMediaSessionsShareCoreForProduction, createMediaSettingsCoreForProduction, SHARED_CURRENT_JOBS_MAX, type MediaSettingValue } from "@/lib/sync-gateway";
import { changedSharedFields, createSettingsSync } from "./settings-sync";
import { createStoryboardGateForProduction } from "@/lib/storyboards";
import { createVideoProjectsServiceForProduction } from "@/lib/video-projects";

type JobScheduling = "background" | "detached";

/**
 * Phase 14 (docs/roadmap/plans/PHASE_14_PLAN.md) -- see `./contracts.ts`. One core: the slice-1
 * foundation (credentials, settings, catalog, pods/S3 passthrough), the slice-2 sessions, the slice-3
 * templates/jobs/exchange and the slice-4 models.
 *
 * ONE instance per process and scheduling mode (kept on `globalThis`, like the operation registry):
 * the watch loop in `src/instrumentation.ts`, every API route and the MCP server must share the same
 * in-flight job set and the same serialized pulls-list writer, or they would poll a job twice and race
 * on the pulls JSON (review round 3). Next's dev hot-reload re-evaluates modules, which `globalThis`
 * survives.
 */
export function createMediaGenerationCore(options: { jobScheduling?: JobScheduling } = {}) {
  // "detached" (the operator CLI, the MCP server): a submitted job is NOT polled by that process -- the web
  // server's watch loop picks it up (`resumeInFlightJobs`), so the CLI exits at once and nothing is polled twice.
  const jobScheduling = options.jobScheduling ?? "background";
  const holder = globalThis as unknown as Record<symbol, MediaGenerationCoreInstance | undefined>;
  const key = jobScheduling === "detached" ? DETACHED_KEY : BACKGROUND_KEY;
  return (holder[key] ??= buildCore(jobScheduling));
}

const BACKGROUND_KEY = Symbol.for("youtube-operations-manager.media-generation-core.background");
const DETACHED_KEY = Symbol.for("youtube-operations-manager.media-generation-core.detached");

function buildCore(jobScheduling: JobScheduling) {
  const now = () => new Date();
  // The detached CLI must be able to exit while a confirm poll's timer is pending.
  const sleep = (ms: number) => sharedSleep(ms, { unref: jobScheduling === "detached" });
  // The one "volume busy" lock (review round 9, `volume-lock.ts`; shared/exclusive since slice 6): pulls and operator
  // pods take it exclusively, sessions hold it by being active rows; its staleness
  // check asks the holder's own module whether that holder is still active (late-bound: both are built below).
  let sessionsRef: ReturnType<typeof createMediaSessionServices> | null = null;
  let modelsRef: ReturnType<typeof createMediaModelServices> | null = null;
  let baseRef: ReturnType<typeof createMediaGenerationServices> | null = null;
  let jobsRef: { modelUsage(): Promise<MediaModelUsage> } | null = null;
  const isHolderActive = async (holder: string): Promise<boolean> => {
    if (holder.startsWith("session:")) return (await sessionsRef?.holdsVolumeLock(holder.slice("session:".length))) ?? false;
    if (holder.startsWith("pull:")) return (await modelsRef?.isPullActive(holder.slice("pull:".length))) ?? false;
    if (holder.startsWith("pod:")) {
      // An operator pod (CLI/scripts) holds the volume while a live pod of its name exists; unknown (RunPod down) = active.
      // No credentials at all is NOT "unknown": nothing could ever check or terminate that pod, and treating the holder
      // as active would block saving the very credentials needed (review round 19) -- the lock then ages out.
      let client;
      try {
        client = await baseRef!.resolveRunpodClient();
      } catch (error) {
        return !(error instanceof DomainError && error.code === "media_generation_not_configured");
      }
      try {
        return Boolean(await findLivePodByName(client, holder.slice("pod:".length)));
      } catch {
        return true;
      }
    }
    return false;
  };
  const volumeLock = createVolumeLock({ store: createVolumeLockStore(), isHolderActive, log: (line) => console.warn(line) });
  const base = createMediaGenerationServices({
    store: createMediaGenerationStore(),
    // BL-199 (ADR 0042): the RunPod/S3 set lives in this computer's shared secret store (moved there from media_credentials on
    // first use); session tokens are sealed with the same store's key, opened with the legacy media key as a fallback.
    secret: getDeviceSecrets().slot("runpod"),
    sealer: { seal: (plaintext) => getDeviceSecrets().seal(plaintext), open: (payload) => getDeviceSecrets().open(payload) },
    gateway: {
      createRunpodClient: (apiKey) => createRunpodApiClient({ apiKey }),
      createS3Client: (config) => createRunpodS3Client(config),
    },
    clock: { now },
    activeVolumeHolder: async () => {
      const holder = await volumeLock.holder();
      if (holder && (await isHolderActive(holder.owner))) return holder.owner;
      // Slice 6: sessions hold the volume by being active, with no lock row of their own.
      const [first] = (await sessionsRef?.activeSessionIds()) ?? [];
      return first ? `session:${first}` : null;
    },
    volumeLock,
    log: (line) => console.warn(line),
  });
  baseRef = base;
  // BL-134 (FO-REQ-0028, ADR 0042): the Hugging Face read token lives in the shared device-secret store.
  const hub = createHuggingFaceClient();
  const hfToken = createHfTokenServices({ slot: getDeviceSecrets().slot("huggingface"), hub });
  // BL-200 (FO-REQ-0029, ADR 0043): pod runtime profiles on the network volume, built on CPU pods (stage 2).
  const runtimeBuilds = createRuntimeBuildServices({
    store: createRuntimeBuildStore(),
    base: { getSettings: () => base.getSettings(), resolveRunpodClient: () => base.resolveRunpodClient(), s3: () => base.s3() },
    // The installed app's own copy (Mac and Windows both run from the repository checkout, `scripts/` included).
    // LF only (review): a Windows checkout with autocrlf would otherwise upload a CRLF start script that bash cannot run.
    readPodScript: async (name) => (await readFile(path.join(process.cwd(), "scripts", "media", "pod", name), "utf8")).replace(/\r\n/g, "\n"),
    events: createMediaControlEventSink(),
    generateId: () => randomUUID(),
    clock: { now },
    sleep,
  });
  const runtimes = createRuntimeServices({
    s3: () => base.s3(),
    github: createGithubClient(),
    getSettings: () => base.getSettings(),
    events: createMediaControlEventSink(),
    clock: { now },
    buildingRuntimeIds: async () => new Set((await runtimeBuilds.listRuntimeBuilds()).filter((j) => j.status === "running").map((j) => j.runtimeId)),
  });
  const models = createMediaModelServices({
    store: createModelPullStore(),
    hub,
    hfToken: () => hfToken.readHfToken(),
    events: createMediaControlEventSink(),
    // Late-bound: the job services (which own the templates) are built below.
    modelUsage: async () => {
      if (!jobsRef) throw new Error("media job services are not ready");
      return jobsRef.modelUsage();
    },
    base: { getSettings: () => base.getSettings(), resolveRunpodClient: () => base.resolveRunpodClient(), s3: () => base.s3() },
    generateId: () => randomUUID(),
    clock: { now },
    volumeLock,
  });
  modelsRef = models;
  const migration = createVolumeMigrationServices({ base, clock: { now }, sleep, log: (line) => console.warn(line) });
  // BL-172 (FO-REQ-0016 B): the GPU availability log (every 15 minutes since BL-206) (the timer in src/instrumentation.ts, the factory read tool).
  const gpuAvailabilityLog = createGpuAvailabilityLogServices({
    store: {
      latestAt: () => getLatestMediaGpuAvailabilityAt(),
      insertSnapshot: (at, rows) => insertMediaGpuAvailabilitySnapshot(at, rows),
      list: (filter) => listMediaGpuAvailabilityLog(filter),
      summarize: (filter) => summarizeMediaGpuAvailabilityLog(filter),
    },
    base,
    clock: { now },
    log: (line) => console.warn(line),
  });
  // BL-206 (FO-REQ-0033): GPU availability and session-wait statistics -- local reads only, no RunPod client in reach.
  const gpuStats = createGpuStatsServices({
    store: {
      availabilityCells: (filter) => countMediaGpuAvailabilityCells(filter),
      sessionsFirstApprovedBetween: (since, until) => listSessionsFirstApprovedBetween(since, until),
    },
    settingsCandidates: async () => {
      const settings = await base.getSettings();
      return [...new Set([settings.gpuTypeId, ...settings.gpuFallbackIds].filter((id): id is string => Boolean(id)))];
    },
    clock: { now },
  });
  const sessions = createMediaSessionServices({
    store: createMediaSessionStore(),
    jobSummary: (sessionId) => getMediaSessionJobSummary(sessionId),
    capacityLog: { record: (attempt) => insertMediaCapacityAttempt(attempt), setHostCuda: (attemptId, host) => setMediaCapacityAttemptHostCuda(attemptId, host), setTimings: (attemptId, timings) => setMediaCapacityAttemptTimings(attemptId, timings) },
    events: createMediaControlEventSink(),
    base,
    createComfyClient: ({ baseUrl, token }) => createComfyUiClient({ baseUrl, token }),
    comfyUiProxyBaseUrl,
    generateId: () => randomUUID(),
    generateToken: () => randomBytes(24).toString("base64url"),
    clock: { now },
    sleep,
    volumeLock,
    log: (line) => console.warn(line),
    // BL-138: devices on the same RunPod account share the limits (late-bound: the helpers are defined below).
    accountWide: (at, localPodIds, options) => otherDevicesOnAccount(at, localPodIds, options),
    // BL-200 (AC-RT-04): `.ready` on the volume is the build's own last step.
    runtimes: {
      isReady: async (runtimeId) => (await (await base.s3()).headObject(`ytm/runtimes/${runtimeId}/.ready`)) !== null,
      ensurePodScripts: () => runtimeBuilds.ensurePodScripts(),
    },
  });
  sessionsRef = sessions;
  const workspaces = createChannelWorkspacesCore();
  const assets = createAssetCatalogCore();
  const jobs = createMediaJobServices({
    store: createMediaJobStore(),
    // BL-144: live ComfyUI progress of the jobs this core watches (the core itself is one per process, on globalThis).
    progress: createJobProgressRegistry(),
    sessions: {
      async getRunningSession(sessionId) {
        // Contracted as "null when not running"; an unknown id is "not running", never a throw out of a resume loop.
        let session;
        try {
          session = await sessions.getSession({ sessionId });
        } catch (error) {
          if (error instanceof DomainError && error.code === "media_session_not_found") return null;
          throw error;
        }
        return session.status === "running"
          ? { sessionId: session.sessionId, channelId: session.channelId, podId: session.podId, gpuTypeId: session.gpuTypeId, costPerHr: session.costPerHr, hostCudaVersion: session.hostCudaVersion, runtimeId: session.runtimeId }
          : null;
      },
      comfyClientForSession: (sessionId) => sessions.comfyClientForSession(sessionId),
      touchActivity: (sessionId) => sessions.touchActivity(sessionId),
    },
    s3: () => base.s3(),
    runtimeTested: (runtimeId) => runtimes.testedNodes(runtimeId),
    async resolveOutputRoot(channelId) {
      const workspace = await workspaces.getWorkspace({ channelId });
      if (!workspace.configured) {
        throw new DomainError({
          code: "media_workspace_unavailable",
          message: "This channel has no workspace folder on this device (Settings → Channels); outputs are written only there.",
          details: { channelId },
        });
      }
      return resolveFromYtmDir({
        workspace: workspace.path,
        fs: createExchangeFs(),
        validateWorkspacePath: validateOperatorDirectoryPath,
        isPathInsideOrEqual,
        unavailable: (reason) =>
          new DomainError({ code: "media_workspace_unavailable", message: `The channel's workspace folder cannot receive outputs: ${reason}`, details: { channelId, reason } }),
      });
    },
    fs: createExchangeLocalFs(),
    // BL-132 (plan §2.4): job inputs come only from the channel's `99 Data Exchange/Sent to YTM/`, proven contained.
    async resolveInputFile(channelId, relativePath) {
      const workspace = await workspaces.getWorkspace({ channelId });
      const unavailable = (reason: string) => new DomainError({ code: "media_input_unavailable", message: `Job input ${relativePath}: ${reason}`, details: { channelId, relativePath, reason } });
      if (!workspace.configured) throw unavailable("this channel has no workspace folder on this device (Settings → Channels)");
      return resolveSentToYtmFile({ workspace: workspace.path, relativePath, fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable });
    },
    // For the manifest only (FO-REQ-0002): read, never created here; an unreadable config is "unknown", never a reason
    // to hold a finished job back.
    device: async () => ({
      deviceId: await createBootstrapConfigStore(appDataPaths.bootstrapConfigPath)
        .read()
        .then((config) => config?.deviceId ?? null)
        .catch(() => null),
      hostname: (() => {
        try {
          return hostname() || null;
        } catch {
          return null;
        }
      })(),
    }),
    registerAsset: async (input) => {
      const asset = await assets.registerAsset(input);
      return { assetId: asset.assetId };
    },
    findAssetByLocalPath: async (channelId, localPath) => {
      const match = await assets.findAssetByReference({ channelId, referenceKind: "local_path", referenceValue: localPath });
      return match ? { assetId: match.assetId } : null;
    },
    generateId: () => randomUUID(),
    clock: { now },
    sleep,
    schedule:
      jobScheduling === "detached"
        ? () => undefined
        : (run) => void run().catch((error) => console.warn(`[media] job processing failed: ${error instanceof Error ? error.message : String(error)}`)),
    log: (line) => console.warn(line),
    // BL-132: the factory template registry folder (logical path `media_templates`, read for this device only).
    registry: createTemplateRegistryReader({
      resolveDir: async () => (await createLogicalPathsCore().readPath({ name: "media_templates" }, "factory")).path,
    }),
    events: createMediaControlEventSink(),
    syncState: { get: () => getMediaTemplateSyncLastJson(), set: (json) => setMediaTemplateSyncLastJson(json) },
    adoptions: { get: () => getMediaTemplateAdoptionsJson(), set: (json) => setMediaTemplateAdoptionsJson(json) },
    // BL-184 stage 2 (ADR 0038 §4): the storyboards module's gate, over the same synced document the owner approves in.
    storyboardGate: createStoryboardGateForProduction(),
    // BL-194 (ADR 0040): the video a job is made for (the shared video-projects module; an inherited one never blocks a job).
    videoLink: { resolve: (input) => createVideoProjectsServiceForProduction().resolveJobVideo(input) },
  });
  jobsRef = jobs;
  // BL-200 stage 3 (AC-RT-05/09): a runtime test -- the build if needed, a GPU session capped by the owner's test limit, the node
  // list against each template, test.json. The Operator's session goes through its own factory limits; the owner's is approved
  // as the owner.
  /** FO-REQ-0030: the "nodeId.input" pairs a template's parameters fill at job time (they count as set in its graph). */
  const parameterInputsOf = (parametersJson: string): string[] => {
    try {
      const parameters = JSON.parse(parametersJson) as Array<{ nodeId?: unknown; input?: unknown }>;
      return Array.isArray(parameters) ? parameters.filter((p) => typeof p.nodeId === "string" && typeof p.input === "string").map((p) => `${p.nodeId}.${p.input}`) : [];
    } catch {
      return [];
    }
  };
  const runtimeTemplates = async () =>
    (await createMediaJobStore().templates.list()).map((t) => ({ templateId: t.id, version: t.version, source: t.source ?? ("owner" as const), workflowJson: t.workflowJson, parameterInputs: parameterInputsOf(t.parametersJson) }));
  const runtimeTests = createRuntimeTestServices({
    store: createRuntimeTestStore(),
    getSettings: () => base.getSettings(),
    runtimes: { getRuntime: (runtimeId) => runtimes.getRuntime(runtimeId), writeTestResult: (runtimeId, result) => runtimes.writeTestResult(runtimeId, result) },
    builds: { start: (runtimeId, actor) => runtimeBuilds.startRuntimeBuild({ runtimeId }, { actor }), list: () => runtimeBuilds.listRuntimeBuilds() },
    sessions: {
      async start({ channelId, runtimeId, maxMinutes, maxUsd, actor }) {
        if (actor === "factory") {
          const started = await sessions.factoryStartSession({ channelId, runtimeId, maxMinutes, maxUsd, releaseWhenDone: false });
          return { sessionId: started.session.sessionId, approved: started.approved, heldBy: started.heldBy };
        }
        const pending = await sessions.requestSession({ channelId, requestedBy: "operator", runtimeId, maxMinutes, maxUsd, releaseWhenDone: false, reason: `pod runtime test (${runtimeId})` });
        try {
          const { started } = await sessions.approveSession({ sessionId: pending.sessionId });
          started.catch(() => undefined); // the test reads the session's state; a failed start is its answer
          return { sessionId: pending.sessionId, approved: true, heldBy: null };
        } catch (error) {
          return { sessionId: pending.sessionId, approved: false, heldBy: error instanceof Error ? error.message : String(error) };
        }
      },
      get: (sessionId) => sessions.getSession({ sessionId }),
      async readNodes(sessionId) {
        const comfy = await sessions.comfyClientForSession(sessionId);
        const [objectInfo, stats] = await Promise.all([comfy.getObjectInfo(), comfy.getSystemStats()]);
        return { objectInfo, comfyVersion: comfyVersionOf(stats) };
      },
      async stop(sessionId, actor) {
        if (actor === "factory") return sessions.factoryStopSession({ sessionId });
        const current = await sessions.getSession({ sessionId });
        return current.status === "pending" ? sessions.rejectSession({ sessionId, reason: "pod runtime test withdrawn" }) : sessions.stopSession({ sessionId, reason: "pod runtime test finished" });
      },
    },
    templates: runtimeTemplates,
    events: createMediaControlEventSink(),
    generateId: () => randomUUID(),
    clock: { now },
  });
  /**
   * BL-200 (AC-RT-07): a template whose graph needs node types the runtime's tested list lacks is refused before any pod starts.
   * `runtimeId` undefined = the active one; null (the built-in ComfyUI) and an untested runtime have no list and are not checked.
   */
  const assertTemplateFitsRuntime = async (input: { templateId: string; runtimeId?: string | null }) => {
    const runtimeId = input.runtimeId !== undefined ? input.runtimeId : (await base.getSettings()).activeRuntimeId;
    if (!runtimeId) return;
    const tested = await runtimes.testedNodes(runtimeId);
    const template = (await runtimeTemplates()).find((t) => t.templateId === input.templateId);
    if (!tested || !template) return;
    // FO-REQ-0030: also the input problems the runtime's test found in this template version.
    const refusal = runtimeIncompatibleError(input.templateId, runtimeId, templateRuntimeProblems(template, tested));
    if (refusal) throw refusal;
  };
  /** BL-132 audit (plan §2.5): newest first. */
  const listControlEvents = async (limit = 50): Promise<MediaControlEventView[]> =>
    (await listMediaControlEvents(Math.min(Math.max(1, limit), 200))).map((row) => ({
      at: row.at.toISOString(),
      actor: row.actor as MediaControlEventView["actor"],
      action: row.action,
      subject: row.subject,
      details: row.detailsJson ? (JSON.parse(row.detailsJson) as Record<string, unknown>) : null,
    }));
  /** BL-133 capacity log (plan §2.5): newest first. */
  const listCapacityAttempts = async (filter: { since?: Date; gpuTypeId?: string; limit?: number } = {}): Promise<MediaCapacityAttempt[]> =>
    (await listMediaCapacityAttempts({ since: filter.since, gpuTypeId: filter.gpuTypeId, limit: Math.min(Math.max(1, filter.limit ?? 100), 500) })).map((row) => ({
      at: row.at.toISOString(),
      sessionId: row.sessionId,
      datacenterId: row.datacenterId ?? null,
      gpuTypeId: row.gpuTypeId,
      pricePerHr: row.pricePerHr ?? null,
      result: row.result as MediaCapacityAttempt["result"],
      detail: row.detail ?? null,
      hostCudaVersion: row.hostCudaVersion ?? null,
      containerSeconds: row.containerSeconds ?? null,
      bootSeconds: row.bootSeconds ?? null,
    }));
  // BL-138: the RunPod account id (a GraphQL read). Kept an hour when known, 5 minutes when it could not be read, and dropped
  // as soon as the stored credentials change (independent review: a replaced or imported key may be another account).
  let accountIdCache: { value: string | null; at: number; credentialsAt: string | null } | null = null;
  const runpodAccountId = async (): Promise<string | null> => {
    const status = await base.getCredentialsStatus();
    const credentialsAt = status.configured ? status.updatedAt : null;
    if (!credentialsAt) return null;
    const ttl = accountIdCache?.value ? 60 * 60_000 : 5 * 60_000;
    if (accountIdCache && accountIdCache.credentialsAt === credentialsAt && now().getTime() - accountIdCache.at < ttl) return accountIdCache.value;
    const value = await base
      .resolveRunpodClient()
      .then((client) => client.getAccountId())
      .catch(() => null);
    accountIdCache = { value, at: now().getTime(), credentialsAt };
    return value;
  };
  const deviceIdentity = async () => {
    const config = await createBootstrapConfigStore(appDataPaths.bootstrapConfigPath).ensureExists();
    let host: string | null = null;
    try {
      host = hostname() || null;
    } catch {
      host = null;
    }
    return { deviceId: config.deviceId, hostname: host };
  };
  // One RunPod pod list per 25 s at most for the watcher's checks (one in flight is shared by every session of a tick); the
  // approve asks for a fresh one.
  let livePodsCache: { pods: Promise<Array<{ id: string; name: string; status: string }>>; at: number } | null = null;
  const livePodsForLimits = (at: Date, fresh: boolean) => {
    if (fresh || !livePodsCache || at.getTime() - livePodsCache.at > 25_000) {
      const pods = base.resolveRunpodClient().then((client) => client.listPods()).then((list) => list.map((p) => ({ id: p.id, name: p.name, status: p.status })));
      livePodsCache = { pods, at: at.getTime() };
      pods.catch(() => {
        if (livePodsCache?.pods === pods) livePodsCache = null;
      });
    }
    return livePodsCache.pods;
  };
  async function otherDevicesOnAccount(at: Date, localPodIds: string[], options: { fresh?: boolean; spendOnly?: boolean } = {}) {
    const ownAccountId = await runpodAccountId();
    if (!ownAccountId) return { otherActiveSessions: 0, otherSpentTodayUsd: 0 };
    // The pod list failing leaves the reported spend in (it does not need RunPod). BL-193: a spend-only read (the limits the UI
    // polls) never asks RunPod for the pod list.
    const [pods, peers] = await Promise.all([options.spendOnly ? Promise.resolve(null) : livePodsForLimits(at, options.fresh ?? false).catch(() => null), createMediaSessionsShareCoreForProduction().listPeerReports()]);
    return accountWideUsage({ peers, ownAccountId, livePods: pods, localPodIds, dayStart: new Date(at.getFullYear(), at.getMonth(), at.getDate()), now: at });
  }
  /** BL-138: hands this device's sessions report to the sync-gateway `media-sessions` family (run on every watcher tick). */
  const publishSessionsShare = async (): Promise<void> => {
    const [identity, list, limits, accountId] = await Promise.all([deviceIdentity(), sessions.listSessions(200), sessions.getLimits(), runpodAccountId()]);
    // BL-148: the open sessions' jobs (with BL-144 live progress), so the other devices can follow the work.
    const jobsBySession: Record<string, SessionJobsInput> = {};
    for (const s of list) {
      if ((MEDIA_SESSION_TERMINAL_STATUSES as readonly string[]).includes(s.status)) continue;
      const share = await jobs.sessionJobsForShare(s.sessionId, SHARED_CURRENT_JOBS_MAX);
      if (share) jobsBySession[s.sessionId] = share;
    }
    await createMediaSessionsShareCoreForProduction().publishLocalReport(
      buildSessionsReport({ ...identity, runpodAccountId: accountId, now: now(), sessions: list, spentTodayUsd: limits.spentTodayUsd, jobsBySession })
    );
  };
  /** BL-138: the other devices' sessions, checked against RunPod's live pods (one read), plus pods no device reports. */
  const listOtherDevices = async (): Promise<OtherDevicesView> => {
    const [peers, local, accountId] = await Promise.all([createMediaSessionsShareCoreForProduction().listPeerReports(), sessions.listSessions(200), runpodAccountId()]);
    let livePods: Array<{ id: string; name: string; costPerHr: number | null; status: string }> | null = null;
    let podsError: string | null = null;
    try {
      livePods = (await base.listPods()).map((p) => ({ id: p.id, name: p.name, costPerHr: p.costPerHr, status: p.status }));
    } catch (error) {
      podsError = error instanceof Error ? error.message : String(error);
    }
    return deriveOtherDevices({ peers, ownAccountId: accountId, localPodIds: local.map((s) => s.podId).filter((id): id is string => Boolean(id)), livePods, podsError, now: now() });
  };
  /** BL-138 (owner, msg 1739): Stop for a session another device started -- terminates its pod through RunPod directly. */
  const stopOtherDeviceSession = (input: unknown) =>
    stopPeerSession(
      {
        listPeerReports: () => createMediaSessionsShareCoreForProduction().listPeerReports(),
        localPodIds: async () => (await sessions.listSessions(200)).map((s) => s.podId).filter((id): id is string => Boolean(id)),
        ownAccountId: runpodAccountId,
        runpodClient: () => base.resolveRunpodClient(),
        podNameFor,
        clock: { now },
        sleep,
        record: (event) => createMediaControlEventSink().record({ actor: "owner", ...event }),
      },
      input
    );
  // -- BL-150: the Setup settings shared with the other devices (sync-gateway `media-settings`) ------------------------------
  const settingsSync = createSettingsSync({
    shared: createMediaSettingsCoreForProduction(),
    getSettings: () => base.getSettings(),
    applyUpdate: (patch) => base.updateSettings(patch),
    async sameAccount() {
      // Fail closed, but never fail the tick (review): an unreadable report only holds the account-bound fields. A device that has
      // not reported for a day (switched off, retired) does not hold them forever.
      try {
        const own = await runpodAccountId();
        if (!own) return false;
        const dayAgo = Date.now() - 24 * 60 * 60_000;
        const peers = (await createMediaSessionsShareCoreForProduction().listPeerReports()).filter((p) => Date.parse(p.updatedAt) >= dayAgo);
        return peers.length > 0 && peers.every((p) => p.runpodAccountId === own);
      } catch {
        return false;
      }
    },
    record: (event) => createMediaControlEventSink().record({ actor: "sync", ...event }),
    clock: { now },
  });
  /** An edit in Setup: validated and saved as before, then the fields it changed are shared (a failure to share never fails the save). */
  const saveAndShare = (input: unknown, options: { allowActiveRuntime?: boolean } = {}) => settingsSync.exclusive(async () => {
    const before = await base.getSettings();
    // BL-200 (AC-RT-06): the active runtime changes only through setActiveRuntime (a passed test, the Operator's switch). A form
    // that resends every field unchanged is fine.
    if (!options.allowActiveRuntime) assertActiveRuntimeUnchanged(input, before.activeRuntimeId);
    const after = await base.updateSettings(input);
    const changed = changedSharedFields(before, after);
    if (Object.keys(changed).length > 0) {
      await createMediaSettingsCoreForProduction()
        .publishChanged(changed as Record<string, MediaSettingValue>)
        .catch((error: unknown) => console.warn(`[media-settings] the change was saved here but not shared: ${error instanceof Error ? error.message : String(error)}`));
    }
    return after;
  });
  const updateSettings = (input: unknown) => saveAndShare(input);
  /** BL-200 (AC-RT-06): make a tested runtime active (or `null`: the image's built-in ComfyUI). Rollback = the previous id. */
  const setActiveRuntime = async (input: { runtimeId: string | null }, options: { actor?: "owner" | "factory" } = {}) => {
    const actor = options.actor ?? "owner";
    const { from, to } = await runtimes.checkActivation(input.runtimeId, actor);
    const settings = from === to ? await base.getSettings() : await saveAndShare({ activeRuntimeId: to }, { allowActiveRuntime: true });
    await createMediaControlEventSink().record({ actor, action: "runtime_activated", subject: to ?? "built-in", details: { from, to } });
    return { activeRuntimeId: settings.activeRuntimeId, previousRuntimeId: from };
  };
  /** The owner picked one value of a conflicted setting (Merge, or the startup window): shared at once, applied here at once. */
  const resolveSettingConflict = async (input: { field: string; value: MediaSettingValue }) => {
    await settingsSync.exclusive(() => createMediaSettingsCoreForProduction().resolveConflict(input));
    return settingsSync.tick();
  };

  return {
    ...base,
    listRuntimes: runtimes.listRuntimes,
    getRuntime: runtimes.getRuntime,
    listComfyReleases: runtimes.listComfyReleases,
    createRuntime: runtimes.createRuntime,
    runtimeTestedNodes: runtimes.testedNodes,
    startRuntimeBuild: runtimeBuilds.startRuntimeBuild,
    pollRuntimeBuilds: runtimeBuilds.pollRuntimeBuilds,
    listRuntimeBuilds: runtimeBuilds.listRuntimeBuilds,
    ensurePodScripts: runtimeBuilds.ensurePodScripts,
    testRuntime: runtimeTests.testRuntime,
    pollRuntimeTests: runtimeTests.pollRuntimeTests,
    listRuntimeTests: runtimeTests.listRuntimeTests,
    setActiveRuntime,
    assertTemplateFitsRuntime,
    getHfToken: hfToken.getHfToken,
    setHfToken: hfToken.setHfToken,
    testHfToken: hfToken.testHfToken,
    clearHfToken: hfToken.clearHfToken,
    /** BL-134: for the password-encrypted cloud-keys file only (`cloud-credentials-transfer`), never a route. */
    exportHfTokenForTransfer: hfToken.readHfToken,
    checkHfTokenForImport: hfToken.checkHfTokenForImport,
    storeCheckedHfToken: hfToken.storeCheckedHfToken,
    ...sessions,
    ...jobs,
    ...models,
    ...migration,
    ...gpuAvailabilityLog,
    ...gpuStats,
    updateSettings,
    listControlEvents,
    listCapacityAttempts,
    publishSessionsShare,
    listOtherDevices,
    stopOtherDeviceSession,
    syncSharedSettings: () => settingsSync.tick(),
    getSettingsSyncStatus: () => settingsSync.status(),
    peekSettingsSync: () => settingsSync.peek(),
    resolveSettingConflict,
    /**
     * BL-194 stage 2 (ADR 0041): splits every ended session's RunPod charge across its jobs (GPU seconds, pod start / idle time
     * shared in proportion), old sessions included as estimates. Run by its own loop in `instrumentation.ts`.
     */
    splitEndedSessionCosts: () =>
      splitEndedSessionCosts({
        pending: async () =>
          (await listMediaSessionsNeedingCostSplit()).map(({ session, jobs }) => ({
            session: { id: session.id, usdCharged: session.usdCharged ?? null, costPerHr: session.costPerHr ?? null },
            jobs: jobs.map((j) => ({ id: j.id, status: j.status, createdAt: j.createdAt, submittedAt: j.submittedAt ?? null, startedAt: j.startedAt ?? null, gpuFinishedAt: j.gpuFinishedAt ?? null, finishedAt: j.finishedAt ?? null })),
          })),
        store: (jobId, share) => setMediaJobCostShare(jobId, share),
        log: (line) => console.warn(line),
      }),
  };
}

type MediaGenerationCoreInstance = ReturnType<typeof buildCore>;

export type MediaGenerationCore = ReturnType<typeof createMediaGenerationCore>;
export { isDomainError, DomainError } from "./contracts";
export type {
  MediaCredentialsStatus,
  MediaCredentialsTestResult,
  MediaGenerationOverview,
  MediaJob,
  MediaJobOutput,
  MediaSession,
  MediaSessionLimits,
  MediaSettings,
  MediaTemplateParameter,
  MediaWorkflowTemplate,
} from "./contracts";
export { DEFAULT_MEDIA_SETTINGS, NETWORK_VOLUME_USD_PER_GB_MONTH } from "./contracts";
export { jobErrorCode, withJobErrorCode } from "./cuda-host";
export { splitSessionCost } from "./cost-split";
export type { CostShare, CostSplitJob } from "./cost-split";
// BL-188: the shared jobs list carries a job's live progress in the shape the other devices may see (no `detail`).
export { toSharedJobProgress } from "./cross-device";
