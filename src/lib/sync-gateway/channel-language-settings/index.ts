import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createDefaultLogger } from "@/lib/shared-logger";
import { createAutomergeCore, createDiscardedDocumentBackupStore, createFilesystemDocumentStore } from "../automerge-core";
import { createSqlLocalStore } from "./adapters/sql-store";
import { createChannelLanguageSettingsCore, emptyDocument, type ChannelLanguageSettingsCore } from "./services";
import type { ChannelLanguageSettingsDocument } from "./contracts";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled
// separately), so its one-at-a-time queue covers the sync cycle, the owner's saves and the conflict choices together.
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.channelLanguageSettingsCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: ChannelLanguageSettingsCore };

export function createChannelLanguageSettingsCoreForProduction(): ChannelLanguageSettingsCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const store = createFilesystemDocumentStore(paths.channelLanguageSettingsDocDir);
    holder[PRODUCTION_KEY] = createChannelLanguageSettingsCore({
      core: createAutomergeCore<ChannelLanguageSettingsDocument>({
        store,
        discardedBackupStore: createDiscardedDocumentBackupStore(paths.channelLanguageSettingsDiscardedBackupsDir),
        emptyDocument,
      }),
      store,
      local: createSqlLocalStore(),
      logger: createDefaultLogger(),
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createChannelLanguageSettingsCore, genesisDocument } from "./services";
export type { ChannelLanguageSettingsCore, LocalLanguageSettingsStore, ServiceDependencies } from "./services";
export * from "./contracts";
