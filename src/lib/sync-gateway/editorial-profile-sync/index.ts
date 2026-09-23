import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createDefaultLogger } from "@/lib/channel-sync/adapters/logger";
import { listStoredChannels } from "@/lib/db";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createPerChannelFilesystemTransport, createSyncRunner, type SyncRunner } from "../automerge-core";
import { createEditorialProfileCoreForProduction } from "../editorial-profile";
import { isDomainError } from "../editorial-profile/contracts";

/**
 * Production wiring for the editorial-profile document family's own, independent sync cycle --
 * mirrors `change-drafts-sync/index.ts`'s memoized-singleton reasoning exactly (the generic
 * `createSyncRunner`'s single-flight guard lives in closure state on one instance; every API
 * route must resolve to the SAME instance within one running server process).
 */
let productionRunner: SyncRunner | undefined;

export function createEditorialProfileSyncRunnerForProduction(): SyncRunner {
  if (!productionRunner) {
    const paths = getProductionAppPaths();
    const editorialProfile = createEditorialProfileCoreForProduction();

    productionRunner = createSyncRunner({
      syncthingSubfolderName: "editorial-profile",
      bootstrapConfig: createBootstrapConfigStore(paths.bootstrapConfigPath),
      localFallbackDir: paths.editorialProfileSyncFallbackDir,
      listChannelIds: async () => (await listStoredChannels()).map((channel) => channel.channelId),
      family: {
        exportBytes: (channelId) => editorialProfile.exportBytes(channelId),
        async mergeIncoming(channelId, incomingBytes) {
          const { newConflicts } = await editorialProfile.mergeIncoming({ channelId, incomingBytes });
          return { newConflictsCount: newConflicts.length };
        },
        discardLocalAndAdoptPeer: (channelId, incomingBytes) =>
          editorialProfile.discardLocalAndAdoptPeer({ channelId, incomingBytes }),
      },
      transport: createPerChannelFilesystemTransport(),
      logger: createDefaultLogger(),
      isNotFoundError: (error) => isDomainError(error) && error.code === "not_found",
      describeError: (error) => (error instanceof Error ? error.message : "unknown error"),
    });
  }
  return productionRunner;
}
