import { randomBytes, randomUUID } from "node:crypto";
import { createAssetCatalogCore } from "@/lib/asset-catalog";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { appDataPaths } from "@/lib/db";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { comfyUiProxyBaseUrl, createComfyUiClient, createRunpodApiClient, createRunpodS3Client } from "@/lib/media-gateway";
import { sleep as sharedSleep } from "@/lib/shared-async";
import { createExchangeFs, resolveFromYtmDir } from "@/lib/workspace-exchange";
import { createExchangeLocalFs } from "./adapters/exchange-fs";
import { createMediaJobStore } from "./adapters/job-store";
import { createFsKeyFile } from "./adapters/key-file-fs";
import { createMediaSessionStore } from "./adapters/session-store";
import { createMediaGenerationStore, createModelPullStore, createVolumeLockStore } from "./adapters/store";
import { DomainError } from "./contracts";
import { createMediaJobServices } from "./jobs";
import { createMediaModelServices } from "./models";
import { findLivePodByName } from "./pod-lifecycle";
import { createMediaGenerationServices } from "./services";
import { createMediaSessionServices } from "./sessions";
import { createVolumeLock } from "./volume-lock";

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
    keyFile: createFsKeyFile(appDataPaths.appDataDir),
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
  const models = createMediaModelServices({
    store: createModelPullStore(),
    base: { getSettings: () => base.getSettings(), resolveRunpodClient: () => base.resolveRunpodClient(), s3: () => base.s3() },
    generateId: () => randomUUID(),
    clock: { now },
    volumeLock,
  });
  modelsRef = models;
  const sessions = createMediaSessionServices({
    store: createMediaSessionStore(),
    base,
    createComfyClient: ({ baseUrl, token }) => createComfyUiClient({ baseUrl, token }),
    comfyUiProxyBaseUrl,
    generateId: () => randomUUID(),
    generateToken: () => randomBytes(24).toString("base64url"),
    clock: { now },
    sleep,
    volumeLock,
    log: (line) => console.warn(line),
  });
  sessionsRef = sessions;
  const workspaces = createChannelWorkspacesCore();
  const assets = createAssetCatalogCore();
  const jobs = createMediaJobServices({
    store: createMediaJobStore(),
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
          ? { sessionId: session.sessionId, channelId: session.channelId, podId: session.podId, gpuTypeId: session.gpuTypeId, costPerHr: session.costPerHr }
          : null;
      },
      comfyClientForSession: (sessionId) => sessions.comfyClientForSession(sessionId),
      touchActivity: (sessionId) => sessions.touchActivity(sessionId),
    },
    s3: () => base.s3(),
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
  });
  return { ...base, ...sessions, ...jobs, ...models };
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
