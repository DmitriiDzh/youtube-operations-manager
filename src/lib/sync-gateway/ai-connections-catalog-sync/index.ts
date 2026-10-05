import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createDefaultLogger } from "@/lib/shared-logger";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createPerChannelFilesystemTransport, createSyncRunner, type SyncRunner } from "../automerge-core";
import { createAiConnectionsCatalogCoreForProduction } from "../ai-connections-catalog";
import { GLOBAL_DOCUMENT_KEY, isDomainError } from "../ai-connections-catalog/contracts";

/**
 * Production wiring for the ai-connections-catalog's own sync cycle. Reuses the generic
 * PER-CHANNEL `createSyncRunner` with a single, constant "channel" (`GLOBAL_DOCUMENT_KEY`) --
 * this document has no real per-channel scoping at all, but the runner's push/pull/isolate-
 * errors/single-flight shape is otherwise exactly what a single global document needs too, so a
 * separate "single-document sync runner" would just be this same logic with the loop trivially
 * shortened to one iteration. Memoized for the same single-flight reason as the other two
 * production sync factories in this gateway.
 */
// Memoized on `globalThis`, not in module scope (device-sync cross-system audit, 2026-10-01): the
// server-side scheduler (`src/instrumentation.ts`) is compiled separately from the route handlers,
// so a module-level singleton could give it a DIFFERENT instance -- and a different single-flight
// guard -- than the "adopt peer"/"Sync now" routes, letting a cycle and an adoption write the same
// `<deviceId>.automerge` file at once. One instance per process keeps that exclusion real.
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.aiConnectionsCatalogSyncRunner");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: SyncRunner };
const productionHolder = globalThis as GlobalWithInstance;

export function createAiConnectionsCatalogSyncRunnerForProduction(): SyncRunner {
  if (!productionHolder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const catalog = createAiConnectionsCatalogCoreForProduction();

    productionHolder[PRODUCTION_KEY] = createSyncRunner({
      syncthingSubfolderName: "ai-connections-catalog",
      bootstrapConfig: createBootstrapConfigStore(paths.bootstrapConfigPath),
      localFallbackDir: paths.aiConnectionsCatalogSyncFallbackDir,
      listChannelIds: async () => [GLOBAL_DOCUMENT_KEY],
      family: {
        exportBytes: () => catalog.exportBytes(),
        async mergeIncoming(_key, incomingBytes) {
          const { newConflicts } = await catalog.mergeIncoming(incomingBytes);
          return { newConflictsCount: newConflicts.length };
        },
        discardLocalAndAdoptPeer: (_key, incomingBytes) => catalog.discardLocalAndAdoptPeer(incomingBytes),
      },
      transport: createPerChannelFilesystemTransport(),
      logger: createDefaultLogger(),
      isNotFoundError: (error) => isDomainError(error) && error.code === "not_found",
      describeError: (error) => (error instanceof Error ? error.message : "unknown error"),
    });
  }
  return productionHolder[PRODUCTION_KEY];
}
