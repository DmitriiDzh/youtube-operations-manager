import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { writeFileAtomic } from "@/lib/atomic-json-file";
import { createAssetCatalogCore } from "@/lib/asset-catalog";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { appDataPaths } from "@/lib/db";
import { getDeviceSecrets } from "@/lib/device-secrets";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createElevenlabsApiClient, isMediaGatewayEnabled } from "@/lib/media-gateway";
import { createVideoProjectsServiceForProduction } from "@/lib/video-projects";
import { createVoiceResolverForProduction } from "@/lib/voice-registry";
import { createElevenlabsSettingsCoreForProduction, createElevenlabsSpendShareCoreForProduction } from "@/lib/sync-gateway";
import { changedSharedLimits, createElevenlabsSettingsSync, type ElevenlabsSharedValue } from "./settings-sync";
import { createElevenlabsSpendSharePublisher } from "./spend-share";
import { createExchangeFs, resolveFromYtmDir } from "@/lib/workspace-exchange";
import { createElevenlabsStore } from "./adapters/store";
import { DomainError } from "./contracts";
import { createElevenlabsSpeechServices, type ElevenlabsSpeechDeps } from "./services";
import { createElevenlabsWorker } from "./worker";

// ---------------------------------------------------------------------------
// BL-236 (FO-REQ-0050, ADR 0057): the ElevenLabs speech module's public surface. ONE core per process on `globalThis` (the MCP
// route, the Web routes and `src/instrumentation.ts` are separate bundles; the create lock and the worker's in-flight set are shared).
// ---------------------------------------------------------------------------

export * from "./contracts";
export { createElevenlabsSpeechServices, settingsFromJson, listPriceUsd, countedChars, type ElevenlabsSpeechDeps, type ElevenlabsStore, type ElevenlabsDesignedVoice } from "./services";
export { createElevenlabsWorker } from "./worker";
export { accountWideUsage, elevenlabsKeyFingerprint, ELEVENLABS_FINGERPRINT_LABEL, ELEVENLABS_PEER_STALE_AFTER_MS } from "./account";
export { createElevenlabsSpendSharePublisher, ELEVENLABS_SPEND_REPUBLISH_MS } from "./spend-share";
export { changedSharedLimits, createElevenlabsSettingsSync, planElevenlabsPeerApply, sharedLimitValues } from "./settings-sync";
export type { ElevenlabsSettingsSyncStatus, ElevenlabsSettingsConflictView, ElevenlabsPendingSetting, ElevenlabsSharedValue } from "./settings-sync";

const CORE_KEY = Symbol.for("youtube-operations-manager.elevenlabs-speech-core");

function serialLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return async function withLock<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  };
}

function buildDeps(): ElevenlabsSpeechDeps {
  const workspaces = createChannelWorkspacesCore();
  const assets = createAssetCatalogCore();
  return {
    store: createElevenlabsStore(),
    api: createElevenlabsApiClient(),
    secret: getDeviceSecrets().slot("elevenlabs"),
    workspace: {
      async resolveOutputRoot(channelId) {
        const workspace = await workspaces.getWorkspace({ channelId });
        if (!workspace.configured) throw new DomainError({ code: "elevenlabs_workspace_unavailable", message: "This channel has no workspace folder on this computer (Settings → Channels); ElevenLabs outputs are written only there.", details: { channelId } });
        return resolveFromYtmDir({
          workspace: workspace.path,
          fs: createExchangeFs(),
          validateWorkspacePath: validateOperatorDirectoryPath,
          isPathInsideOrEqual,
          unavailable: (reason) => new DomainError({ code: "elevenlabs_workspace_unavailable", message: `The channel's workspace folder cannot receive outputs: ${reason}`, details: { channelId, reason } }),
        });
      },
    },
    files: {
      async writeOutput(filePath, data) {
        await writeFileAtomic(filePath, data);
        return { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
      },
      async writeManifest(filePath, manifest) {
        await writeFileAtomic(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
    },
    assets: {
      register: async (input) => ({ assetId: (await assets.registerAsset(input)).assetId }),
      findByLocalPath: async (channelId, localPath) => {
        const match = await assets.findAssetByReference({ channelId, referenceKind: "local_path", referenceValue: localPath });
        return match ? { assetId: match.assetId } : null;
      },
    },
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
    voices: { resolve: (input) => createVoiceResolverForProduction().resolve(input) },
    videoLink: { resolve: (input) => createVideoProjectsServiceForProduction().resolveJobVideo(input) },
    clock: { now: () => new Date() },
    generateId: () => randomUUID(),
    withCreateLock: serialLock(),
    // BL-236 (owner msg 3823): the other computers' ElevenLabs use, for the limits shared by every computer on one key.
    peerSpendReports: () => createElevenlabsSpendShareCoreForProduction().listPeerReports(),
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
  const services = createElevenlabsSpeechServices(deps);

  // -- BL-236 (owner msg 3823): the character limits shared with the other computers (sync-gateway `elevenlabs-settings`), exactly
  // as the Gemini limits (ADR 0039).
  const settingsSync = createElevenlabsSettingsSync({
    shared: createElevenlabsSettingsCoreForProduction(),
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
        await createElevenlabsSettingsCoreForProduction()
          .publishChanged(changed as Record<string, ElevenlabsSharedValue>)
          .catch((error: unknown) => console.warn(`[elevenlabs-settings] the change was saved here but not shared: ${error instanceof Error ? error.message : String(error)}`));
      }
      return after;
    });
  /** The owner picked one value of a conflicted limit: shared at once, applied here at once. */
  const resolveSettingConflict = async (input: { field: string; value: ElevenlabsSharedValue }) => {
    await settingsSync.exclusive(() => createElevenlabsSettingsCoreForProduction().resolveConflict(input));
    return settingsSync.tick();
  };

  // -- BL-236: this computer's use for the other computers (sync-gateway `elevenlabs-spend`).
  const publishSpendShare = createElevenlabsSpendSharePublisher({
    localUsage: (at) => services.localUsage(at),
    keyFingerprint: () => services.keyFingerprint(),
    deviceId: async () => (await deps.device()).deviceId,
    hostname: hostName,
    publish: (report) => createElevenlabsSpendShareCoreForProduction().publishLocalReport(report),
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
    worker: createElevenlabsWorker(deps),
  };
}

export type ElevenlabsSpeechCore = ReturnType<typeof buildCore>;

export function createElevenlabsSpeechCore(): ElevenlabsSpeechCore {
  const holder = globalThis as unknown as Record<symbol, ElevenlabsSpeechCore | undefined>;
  return (holder[CORE_KEY] ??= buildCore());
}
