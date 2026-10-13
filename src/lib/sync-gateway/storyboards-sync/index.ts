import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createDefaultLogger } from "@/lib/shared-logger";
import { listStoredChannels } from "@/lib/db";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createPerChannelFilesystemTransport, createSyncRunner, type SyncRunner } from "../automerge-core";
import { createStoryboardsCoreForProduction } from "../storyboards";
import { isDomainError } from "../storyboards/contracts";

/**
 * BL-184: the storyboards family's own sync cycle -- the generic per-channel runner with its own Syncthing subfolder, exactly as
 * `channel-publishing-settings-sync`.
 */
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.storyboardsSyncRunner");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: SyncRunner };
const productionHolder = globalThis as GlobalWithInstance;

export function createStoryboardsSyncRunnerForProduction(): SyncRunner {
  if (!productionHolder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const storyboards = createStoryboardsCoreForProduction();
    productionHolder[PRODUCTION_KEY] = createSyncRunner({
      syncthingSubfolderName: "storyboards",
      bootstrapConfig: createBootstrapConfigStore(paths.bootstrapConfigPath),
      localFallbackDir: paths.storyboardsSyncFallbackDir,
      listChannelIds: async () => (await listStoredChannels()).map((channel) => channel.channelId),
      family: {
        exportBytes: (channelId) => storyboards.exportBytes(channelId),
        async mergeIncoming(channelId, incomingBytes) {
          await storyboards.mergeIncoming(channelId, incomingBytes);
          return { newConflictsCount: 0 };
        },
        discardLocalAndAdoptPeer: (channelId, incomingBytes) => storyboards.discardLocalAndAdoptPeer(channelId, incomingBytes),
      },
      transport: createPerChannelFilesystemTransport(),
      logger: createDefaultLogger(),
      isNotFoundError: (error) => isDomainError(error) && error.code === "not_found",
      describeError: (error) => (error instanceof Error ? error.message : "unknown error"),
    });
  }
  return productionHolder[PRODUCTION_KEY];
}
