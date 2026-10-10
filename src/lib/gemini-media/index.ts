import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { createAssetCatalogCore } from "@/lib/asset-catalog";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { appDataPaths } from "@/lib/db";
import { createKeyFile, createKeyFileFsAccess } from "@/lib/device-key-file";
import { createGeminiApiClient, isMediaGatewayEnabled } from "@/lib/media-gateway";
import { createGeminiFiles } from "./adapters/files";
import { createGeminiWorkspace } from "./adapters/workspace";
import { createGeminiStore } from "./adapters/store";
import { DomainError, GEMINI_KEY_FILE_NAME } from "./contracts";
import { createGeminiMediaServices, type GeminiMediaDeps } from "./services";
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
    keyFile: createKeyFile(
      createKeyFileFsAccess(path.join(appDataPaths.appDataDir, GEMINI_KEY_FILE_NAME)),
      (detail) =>
        new DomainError({
          code: "encryption_key_not_configured",
          message: `The Gemini key file exists but is unusable (${detail}). Remove the stored key and enter it again (Settings → Gemini).`,
        })
    ),
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
  };
}

function buildCore() {
  const deps = buildDeps();
  return { ...createGeminiMediaServices(deps), worker: createGeminiWorker(deps) };
}

export type GeminiMediaCore = ReturnType<typeof buildCore>;

export function createGeminiMediaCore(): GeminiMediaCore {
  const holder = globalThis as unknown as Record<symbol, GeminiMediaCore | undefined>;
  return (holder[CORE_KEY] ??= buildCore());
}
