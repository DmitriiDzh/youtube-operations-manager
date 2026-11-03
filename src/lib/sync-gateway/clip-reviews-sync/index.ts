import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createDefaultLogger } from "@/lib/shared-logger";
import { listStoredChannels } from "@/lib/db";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createPerChannelFilesystemTransport, createSyncRunner, type SyncRunner } from "../automerge-core";
import { createClipReviewsCoreForProduction } from "../clip-reviews";
import { isDomainError } from "../clip-reviews/contracts";

/**
 * BL-241 (ADR 0061): the clip reviews family's own sync cycle -- the generic per-channel runner with its own Syncthing subfolder,
 * exactly as `publishing-plans-sync`.
 */
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.clipReviewsSyncRunner");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: SyncRunner };
const productionHolder = globalThis as GlobalWithInstance;

export function createClipReviewsSyncRunnerForProduction(): SyncRunner {
  if (!productionHolder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const reviews = createClipReviewsCoreForProduction();
    productionHolder[PRODUCTION_KEY] = createSyncRunner({
      syncthingSubfolderName: "clip-reviews",
      bootstrapConfig: createBootstrapConfigStore(paths.bootstrapConfigPath),
      localFallbackDir: paths.clipReviewsSyncFallbackDir,
      listChannelIds: async () => (await listStoredChannels()).map((channel) => channel.channelId),
      family: {
        exportBytes: (channelId) => reviews.exportBytes(channelId),
        async mergeIncoming(channelId, incomingBytes) {
          await reviews.mergeIncoming(channelId, incomingBytes);
          return { newConflictsCount: 0 };
        },
        discardLocalAndAdoptPeer: (channelId, incomingBytes) => reviews.discardLocalAndAdoptPeer(channelId, incomingBytes),
      },
      transport: createPerChannelFilesystemTransport(),
      logger: createDefaultLogger(),
      isNotFoundError: (error) => isDomainError(error) && error.code === "not_found",
      describeError: (error) => (error instanceof Error ? error.message : "unknown error"),
    });
  }
  return productionHolder[PRODUCTION_KEY];
}
