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
  };
}

function buildCore() {
  const deps = buildDeps();
  return { ...createElevenlabsSpeechServices(deps), worker: createElevenlabsWorker(deps) };
}

export type ElevenlabsSpeechCore = ReturnType<typeof buildCore>;

export function createElevenlabsSpeechCore(): ElevenlabsSpeechCore {
  const holder = globalThis as unknown as Record<symbol, ElevenlabsSpeechCore | undefined>;
  return (holder[CORE_KEY] ??= buildCore());
}
