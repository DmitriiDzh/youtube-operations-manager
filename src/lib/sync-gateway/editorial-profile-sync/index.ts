import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createDefaultLogger } from "@/lib/shared-logger";
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
// Memoized on `globalThis`, not in module scope (device-sync cross-system audit, 2026-10-01): the
// server-side scheduler (`src/instrumentation.ts`) is compiled separately from the route handlers,
// so a module-level singleton could give it a DIFFERENT instance -- and a different single-flight
// guard -- than the "adopt peer"/"Sync now" routes, letting a cycle and an adoption write the same
// `<deviceId>.automerge` file at once. One instance per process keeps that exclusion real.
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.editorialProfileSyncRunner");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: SyncRunner };
const productionHolder = globalThis as GlobalWithInstance;

export function createEditorialProfileSyncRunnerForProduction(): SyncRunner {
  if (!productionHolder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const editorialProfile = createEditorialProfileCoreForProduction();

    productionHolder[PRODUCTION_KEY] = createSyncRunner({
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
  return productionHolder[PRODUCTION_KEY];
}
