import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createDefaultLogger } from "@/lib/shared-logger";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createPerChannelFilesystemTransport, createSyncRunner, type SyncRunner } from "../automerge-core";
import { createPublishingUploadsShareCoreForProduction } from "../publishing-uploads";
import { GLOBAL_DOCUMENT_KEY, isDomainError } from "../publishing-uploads/contracts";

/**
 * BL-182 stage 2: the uploads report family's own sync cycle -- the generic runner with one constant key, like live-streams. Each
 * device writes only its own report; "adopt the peer's copy" makes no sense for per-device reports, so it is a no-op.
 */
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.publishingUploadsSyncRunner");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: SyncRunner };
const productionHolder = globalThis as GlobalWithInstance;

export function createPublishingUploadsSyncRunnerForProduction(): SyncRunner {
  if (!productionHolder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const share = createPublishingUploadsShareCoreForProduction();
    productionHolder[PRODUCTION_KEY] = createSyncRunner({
      syncthingSubfolderName: "publishing-uploads",
      bootstrapConfig: createBootstrapConfigStore(paths.bootstrapConfigPath),
      localFallbackDir: paths.publishingUploadsSyncFallbackDir,
      listChannelIds: async () => [GLOBAL_DOCUMENT_KEY],
      family: {
        exportBytes: () => share.exportBytes(),
        async mergeIncoming(_key, incomingBytes, peerDeviceId) {
          await share.mergeIncoming(incomingBytes, peerDeviceId);
          return { newConflictsCount: 0 };
        },
        async discardLocalAndAdoptPeer() {
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
