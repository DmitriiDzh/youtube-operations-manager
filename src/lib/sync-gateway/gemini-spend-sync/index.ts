import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createDefaultLogger } from "@/lib/shared-logger";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createPerChannelFilesystemTransport, createSyncRunner, type SyncRunner } from "../automerge-core";
import { createGeminiSpendShareCoreForProduction } from "../gemini-spend";
import { GLOBAL_DOCUMENT_KEY, isDomainError } from "../gemini-spend/contracts";

/**
 * BL-193: the gemini-spend family's own sync cycle -- the generic runner with one constant key, exactly as `media-sessions-sync`.
 * Plain JSON per device (the shared transport still names the file `<deviceId>.automerge`); "adopt the peer's copy" is a no-op.
 */
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.geminiSpendSyncRunner");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: SyncRunner };
const productionHolder = globalThis as GlobalWithInstance;

export function createGeminiSpendSyncRunnerForProduction(): SyncRunner {
  if (!productionHolder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const share = createGeminiSpendShareCoreForProduction();
    productionHolder[PRODUCTION_KEY] = createSyncRunner({
      syncthingSubfolderName: "gemini-spend",
      bootstrapConfig: createBootstrapConfigStore(paths.bootstrapConfigPath),
      localFallbackDir: paths.geminiSpendSyncFallbackDir,
      listChannelIds: async () => [GLOBAL_DOCUMENT_KEY],
      family: {
        exportBytes: () => share.exportBytes(),
        async mergeIncoming(_key, incomingBytes, peerDeviceId) {
          await share.mergeIncoming(incomingBytes, peerDeviceId);
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
