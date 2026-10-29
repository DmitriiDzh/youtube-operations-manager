import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createDefaultLogger } from "@/lib/shared-logger";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createPerChannelFilesystemTransport, createSyncRunner, type SyncRunner } from "../automerge-core";
import { createElevenlabsSettingsCoreForProduction } from "../elevenlabs-settings";
import { GLOBAL_DOCUMENT_KEY, isDomainError } from "../media-settings/contracts";

/** BL-236: the ElevenLabs limits document's own sync cycle -- the generic runner with one constant key, exactly as `media-settings-sync`. */
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.elevenlabsSettingsSyncRunner");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: SyncRunner };
const productionHolder = globalThis as GlobalWithInstance;

export function createElevenlabsSettingsSyncRunnerForProduction(): SyncRunner {
  if (!productionHolder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const settings = createElevenlabsSettingsCoreForProduction();
    productionHolder[PRODUCTION_KEY] = createSyncRunner({
      syncthingSubfolderName: "elevenlabs-settings",
      bootstrapConfig: createBootstrapConfigStore(paths.bootstrapConfigPath),
      localFallbackDir: paths.elevenlabsSettingsSyncFallbackDir,
      listChannelIds: async () => [GLOBAL_DOCUMENT_KEY],
      family: {
        exportBytes: () => settings.exportBytes(),
        async mergeIncoming(_key, incomingBytes) {
          const { newConflicts } = await settings.mergeIncoming(incomingBytes);
          return { newConflictsCount: newConflicts.length };
        },
        discardLocalAndAdoptPeer: (_key, incomingBytes) => settings.discardLocalAndAdoptPeer(incomingBytes),
      },
      transport: createPerChannelFilesystemTransport(),
      logger: createDefaultLogger(),
      isNotFoundError: (error) => isDomainError(error) && error.code === "not_found",
      describeError: (error) => (error instanceof Error ? error.message : "unknown error"),
    });
  }
  return productionHolder[PRODUCTION_KEY];
}
