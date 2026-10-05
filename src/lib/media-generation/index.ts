import { randomBytes, randomUUID } from "node:crypto";
import { createAssetCatalogCore } from "@/lib/asset-catalog";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { appDataPaths } from "@/lib/db";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { comfyUiProxyBaseUrl, createComfyUiClient, createRunpodApiClient, createRunpodS3Client } from "@/lib/media-gateway";
import { createExchangeFs, resolveFromYtmDir } from "@/lib/workspace-exchange";
import { createExchangeLocalFs } from "./adapters/exchange-fs";
import { createMediaJobStore } from "./adapters/job-store";
import { createFsKeyFile } from "./adapters/key-file-fs";
import { createMediaSessionStore } from "./adapters/session-store";
import { createMediaGenerationStore, createModelPullStore } from "./adapters/store";
import { DomainError } from "./contracts";
import { createMediaJobServices } from "./jobs";
import { createMediaModelServices } from "./models";
import { createMediaGenerationServices } from "./services";
import { createMediaSessionServices } from "./sessions";

/**
 * Phase 14 (docs/roadmap/plans/PHASE_14_PLAN.md) -- see `./contracts.ts`. One core: the slice-1
 * foundation (credentials, settings, catalog, pods/S3 passthrough), the slice-2 sessions and the
 * slice-3 templates/jobs/exchange.
 */
export function createMediaGenerationCore() {
  const now = () => new Date();
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const base = createMediaGenerationServices({
    store: createMediaGenerationStore(),
    keyFile: createFsKeyFile(appDataPaths.appDataDir),
    gateway: {
      createRunpodClient: (apiKey) => createRunpodApiClient({ apiKey }),
      createS3Client: (config) => createRunpodS3Client(config),
    },
    clock: { now },
  });
  const models = createMediaModelServices({
    store: createModelPullStore(),
    base: { getSettings: () => base.getSettings(), resolveRunpodClient: () => base.resolveRunpodClient(), s3: () => base.s3() },
    generateId: () => randomUUID(),
    clock: { now },
  });
  const sessions = createMediaSessionServices({
    store: createMediaSessionStore(),
    base,
    createComfyClient: ({ baseUrl, token }) => createComfyUiClient({ baseUrl, token }),
    comfyUiProxyBaseUrl,
    generateId: () => randomUUID(),
    generateToken: () => randomBytes(24).toString("base64url"),
    clock: { now },
    sleep,
    hasActiveModelPull: () => models.hasActivePull(),
    log: (line) => console.warn(line),
  });
  const workspaces = createChannelWorkspacesCore();
  const assets = createAssetCatalogCore();
  const jobs = createMediaJobServices({
    store: createMediaJobStore(),
    sessions: {
      async getRunningSession(sessionId) {
        const session = await sessions.getSession({ sessionId });
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
    generateId: () => randomUUID(),
    clock: { now },
    sleep,
    schedule: (run) => void run().catch((error) => console.warn(`[media] job processing failed: ${error instanceof Error ? error.message : String(error)}`)),
    log: (line) => console.warn(line),
  });
  return { ...base, ...sessions, ...jobs, ...models };
}

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
