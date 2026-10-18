import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createAssetCatalogCore } from "@/lib/asset-catalog";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { appDataPaths } from "@/lib/db";
import { getDeviceSecrets } from "@/lib/device-secrets";
import { createGeminiApiClient, isMediaGatewayEnabled } from "@/lib/media-gateway";
import { createStoryboardGateForProduction } from "@/lib/storyboards";
import { createVideoProjectsServiceForProduction } from "@/lib/video-projects";
import { createGeminiSettingsCoreForProduction, createGeminiSpendShareCoreForProduction } from "@/lib/sync-gateway";
import { createGeminiFiles } from "./adapters/files";
import { createGeminiWorkspace } from "./adapters/workspace";
import { createGeminiStore } from "./adapters/store";
import { createGeminiMediaServices, type GeminiMediaDeps } from "./services";
import { changedSharedLimits, createGeminiSettingsSync, type GeminiSharedValue } from "./settings-sync";
import { createGeminiSpendSharePublisher } from "./spend-share";
import { createGeminiWorker } from "./worker";

// ---------------------------------------------------------------------------
// BL-174 (docs/roadmap/plans/GEMINI_MEDIA_PLAN.md): the Gemini media module's public surface. ONE core per process, kept on
// `globalThis`: the MCP route, the Web routes and `src/instrumentation.ts` are separate Next.js bundles, and the job-create
// lock and the worker's in-flight set must be shared by all of them (the reason `media-generation` does the same).
// ---------------------------------------------------------------------------

export * from "./contracts";
export { estimateImageUsd, estimateVideoUsd, imageCostFromTable, imageCostFromUsage, modelCatalog } from "./pricing";
export { createGeminiMediaServices, settingsFromJson, type GeminiMediaDeps, type GeminiStore } from "./services";
export { createGeminiWorker } from "./worker";
export { accountWideSpend, geminiKeyFingerprint, GEMINI_FINGERPRINT_LABEL, GEMINI_PEER_STALE_AFTER_MS } from "./account";
export { createGeminiSpendSharePublisher, GEMINI_SPEND_REPUBLISH_MS } from "./spend-share";
export { changedSharedLimits, createGeminiSettingsSync, planGeminiPeerApply, sharedLimitValues } from "./settings-sync";
export type { GeminiSettingsSyncStatus, GeminiSettingsConflictView, GeminiPendingSetting, GeminiSharedValue } from "./settings-sync";

const CORE_KEY = Symbol.for("youtube-operations-manager.gemini-media-core");

/** A promise chain: each run starts after the previous one settled (its outcome never leaks into the next). */
export function createSerialLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return async function withLock<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  };
}

function buildDeps(): GeminiMediaDeps {
  const workspaces = createChannelWorkspacesCore();
  const assets = createAssetCatalogCore();
  return {
    store: createGeminiStore(),
    api: createGeminiApiClient(),
    // BL-199 (ADR 0042): the key's slot in this computer's shared secret store (its legacy row moves there on first use).
    secret: getDeviceSecrets().slot("gemini"),
    workspace: createGeminiWorkspace(async (channelId) => workspaces.getWorkspace({ channelId })),
    files: createGeminiFiles(),
    assets: {
      register: async (input) => ({ assetId: (await assets.registerAsset(input)).assetId }),
      findByLocalPath: async (channelId, localPath) => {
        const match = await assets.findAssetByReference({ channelId, referenceKind: "local_path", referenceValue: localPath });
        return match ? { assetId: match.assetId } : null;
      },
    },
    // For the manifest only: an unreadable config is "unknown", never a reason to hold a finished job back.
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
    isChannelConnected: async (channelId) => (await createChannelConnectionsCore().listConnectedChannels()).some((channel) => channel.channelId === channelId),
    isGatewayEnabled: () => isMediaGatewayEnabled(),
    clock: { now: () => new Date() },
    generateId: () => randomUUID(),
    withCreateLock: createSerialLock(),
    // BL-184 stage 2 (ADR 0038 §4): the storyboards module's gate, over the same synced document the owner approves in.
    storyboardGate: createStoryboardGateForProduction(),
    // BL-194 (ADR 0040): the video a job is made for (the shared video-projects module; an inherited one never blocks a job).
    videoLink: { resolve: (input) => createVideoProjectsServiceForProduction().resolveJobVideo(input) },
    // BL-193 (ADR 0039): the other computers' Gemini spend, for the limits shared by every computer on one key.
    peerSpendReports: () => createGeminiSpendShareCoreForProduction().listPeerReports(),
    log: (line) => console.warn(line),
  };
}

function hostName(): string | null {
  try {
    return hostname().slice(0, 255) || null;
  } catch {
    return null;
  }
}

function buildCore() {
  const deps = buildDeps();
  const services = createGeminiMediaServices(deps);

  // -- BL-193: the limits shared with the other computers (sync-gateway `gemini-settings`, ADR 0039) ---------------------------
  const settingsSync = createGeminiSettingsSync({
    shared: createGeminiSettingsCoreForProduction(),
    getSettings: () => services.getSettings(),
    applyUpdate: (patch) => services.updateSettings(patch),
    clock: deps.clock,
  });
  /** An owner's save: validated and stored as before, then the limits it changed are shared (a failure to share never fails the save). */
  const updateSettings = (input: unknown) =>
    settingsSync.exclusive(async () => {
      const before = await services.getSettings();
      const after = await services.updateSettings(input);
      const changed = changedSharedLimits(before, after);
      if (Object.keys(changed).length > 0) {
        await createGeminiSettingsCoreForProduction()
          .publishChanged(changed as Record<string, GeminiSharedValue>)
          .catch((error: unknown) => console.warn(`[gemini-settings] the change was saved here but not shared: ${error instanceof Error ? error.message : String(error)}`));
      }
      return after;
    });
  /** The owner picked one value of a conflicted limit (Merge, or the startup window): shared at once, applied here at once. */
  const resolveSettingConflict = async (input: { field: string; value: GeminiSharedValue }) => {
    await settingsSync.exclusive(() => createGeminiSettingsCoreForProduction().resolveConflict(input));
    return settingsSync.tick();
  };

  // -- BL-193: this computer's spend for the other computers (sync-gateway `gemini-spend`, ADR 0039) --------------------------
  /** Written when the figures or the key changed, and at least every 5 minutes (so the others can tell this computer is alive). */
  const publishSpendShare = createGeminiSpendSharePublisher({
    localSpend: (at) => services.localSpend(at),
    keyFingerprint: () => services.keyFingerprint(),
    deviceId: async () => (await deps.device()).deviceId,
    hostname: hostName,
    publish: (report) => createGeminiSpendShareCoreForProduction().publishLocalReport(report),
    now: () => deps.clock.now(),
  });

  return {
    ...services,
    updateSettings,
    resolveSettingConflict,
    syncSharedSettings: () => settingsSync.tick(),
    getSettingsSyncStatus: () => settingsSync.status(),
    peekSettingsSync: () => settingsSync.peek(),
    publishSpendShare,
    worker: createGeminiWorker(deps),
  };
}

export type GeminiMediaCore = ReturnType<typeof buildCore>;

export function createGeminiMediaCore(): GeminiMediaCore {
  const holder = globalThis as unknown as Record<symbol, GeminiMediaCore | undefined>;
  return (holder[CORE_KEY] ??= buildCore());
}
