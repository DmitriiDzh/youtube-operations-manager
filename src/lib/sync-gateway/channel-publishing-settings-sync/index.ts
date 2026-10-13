import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createDefaultLogger } from "@/lib/shared-logger";
import { listStoredChannels } from "@/lib/db";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createPerChannelFilesystemTransport, createSyncRunner, type SyncRunner } from "../automerge-core";
import { createChannelPublishingSettingsCoreForProduction } from "../channel-publishing-settings";
import { isDomainError } from "../channel-publishing-settings/contracts";

/**
 * BL-182 stage 2: the channel publishing defaults family's own sync cycle -- the generic per-channel runner, its own Syncthing
 * subfolder (a bug in one family's sync never blocks another's), exactly as `channel-language-settings-sync`.
 */
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.channelPublishingSettingsSyncRunner");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: SyncRunner };
const productionHolder = globalThis as GlobalWithInstance;

export function createChannelPublishingSettingsSyncRunnerForProduction(): SyncRunner {
  if (!productionHolder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const settings = createChannelPublishingSettingsCoreForProduction();
    productionHolder[PRODUCTION_KEY] = createSyncRunner({
      syncthingSubfolderName: "channel-publishing-settings",
      bootstrapConfig: createBootstrapConfigStore(paths.bootstrapConfigPath),
      localFallbackDir: paths.channelPublishingSettingsSyncFallbackDir,
      listChannelIds: async () => (await listStoredChannels()).map((channel) => channel.channelId),
      family: {
        exportBytes: (channelId) => settings.exportBytes(channelId),
        async mergeIncoming(channelId, incomingBytes) {
          const { newConflicts } = await settings.mergeIncoming(channelId, incomingBytes);
          return { newConflictsCount: newConflicts.length };
        },
        discardLocalAndAdoptPeer: (channelId, incomingBytes) => settings.discardLocalAndAdoptPeer(channelId, incomingBytes),
      },
      transport: createPerChannelFilesystemTransport(),
      logger: createDefaultLogger(),
      isNotFoundError: (error) => isDomainError(error) && error.code === "not_found",
      describeError: (error) => (error instanceof Error ? error.message : "unknown error"),
    });
  }
  return productionHolder[PRODUCTION_KEY];
}
