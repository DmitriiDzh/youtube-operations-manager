import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createDefaultLogger } from "@/lib/shared-logger";
import { listStoredChannels } from "@/lib/db";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createPerChannelFilesystemTransport, createSyncRunner, type SyncRunner } from "../automerge-core";
import { createPublishingPlansCoreForProduction } from "../publishing-plans";
import { isDomainError } from "../publishing-plans/contracts";

/**
 * BL-225 (ADR 0051): the weekly publishing plans family's own sync cycle -- the generic per-channel runner with its own Syncthing
 * subfolder, exactly as `storyboards-sync`.
 */
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.publishingPlansSyncRunner");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: SyncRunner };
const productionHolder = globalThis as GlobalWithInstance;

export function createPublishingPlansSyncRunnerForProduction(): SyncRunner {
  if (!productionHolder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const plans = createPublishingPlansCoreForProduction();
    productionHolder[PRODUCTION_KEY] = createSyncRunner({
      syncthingSubfolderName: "publishing-plans",
      bootstrapConfig: createBootstrapConfigStore(paths.bootstrapConfigPath),
      localFallbackDir: paths.publishingPlansSyncFallbackDir,
      listChannelIds: async () => (await listStoredChannels()).map((channel) => channel.channelId),
      family: {
        exportBytes: (channelId) => plans.exportBytes(channelId),
        async mergeIncoming(channelId, incomingBytes) {
          await plans.mergeIncoming(channelId, incomingBytes);
          return { newConflictsCount: 0 };
        },
        discardLocalAndAdoptPeer: (channelId, incomingBytes) => plans.discardLocalAndAdoptPeer(channelId, incomingBytes),
      },
      transport: createPerChannelFilesystemTransport(),
      logger: createDefaultLogger(),
      isNotFoundError: (error) => isDomainError(error) && error.code === "not_found",
      describeError: (error) => (error instanceof Error ? error.message : "unknown error"),
    });
  }
  return productionHolder[PRODUCTION_KEY];
}
