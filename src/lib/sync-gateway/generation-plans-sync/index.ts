import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createDefaultLogger } from "@/lib/shared-logger";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createPerChannelFilesystemTransport, createSyncRunner, type SyncRunner } from "../automerge-core";
import { createGenerationPlansShareCoreForProduction } from "../generation-plans";
import { GLOBAL_DOCUMENT_KEY, isDomainError } from "../generation-plans/contracts";

/**
 * BL-143 phase 2: the generation-plans family's own sync cycle (same shape as media-sessions) -- the generic runner with one constant key, like ai-connections-catalog.
 * The document is plain JSON, not Automerge (each device writes only its own report; the shared transport still names the file
 * `<deviceId>.automerge`). "Adopt the peer's copy" makes no sense for per-device reports, so it is a no-op here.
 */
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.generationPlansSyncRunner");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: SyncRunner };
const productionHolder = globalThis as GlobalWithInstance;

export function createGenerationPlansSyncRunnerForProduction(): SyncRunner {
  if (!productionHolder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const share = createGenerationPlansShareCoreForProduction();
    productionHolder[PRODUCTION_KEY] = createSyncRunner({
      syncthingSubfolderName: "generation-plans",
      bootstrapConfig: createBootstrapConfigStore(paths.bootstrapConfigPath),
      localFallbackDir: paths.generationPlansSyncFallbackDir,
      listChannelIds: async () => [GLOBAL_DOCUMENT_KEY],
      family: {
        exportBytes: () => share.exportBytes(),
        async mergeIncoming(_key, incomingBytes) {
          await share.mergeIncoming(incomingBytes);
          return { newConflictsCount: 0 };
        },
        async discardLocalAndAdoptPeer() {
          // Per-device reports are never adopted: each device's report describes only that device.
          return { backupPath: null };
        },
      },
      transport: createPerChannelFilesystemTransport(),
      logger: createDefaultLogger(),
      isNotFoundError: (error) => isDomainError(error) && error.code === "not_found",
      describeError: (error) => (error instanceof Error ? error.message : "unknown error"),
    });
  }
  return productionHolder[PRODUCTION_KEY];
}
