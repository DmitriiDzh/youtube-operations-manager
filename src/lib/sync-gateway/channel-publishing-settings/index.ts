import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createAutomergeCore, createDiscardedDocumentBackupStore, createFilesystemDocumentStore } from "../automerge-core";
import { createChannelPublishingSettingsCore, emptyDocument, type ChannelPublishingSettingsCore } from "./services";
import type { ChannelPublishingSettingsDocument } from "./contracts";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled
// separately), so its one-at-a-time queue covers the sync cycle, the owner's saves and the conflict choices together.
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.channelPublishingSettingsCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: ChannelPublishingSettingsCore };

export function createChannelPublishingSettingsCoreForProduction(): ChannelPublishingSettingsCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const store = createFilesystemDocumentStore(paths.channelPublishingSettingsDocDir);
    holder[PRODUCTION_KEY] = createChannelPublishingSettingsCore({
      core: createAutomergeCore<ChannelPublishingSettingsDocument>({
        store,
        discardedBackupStore: createDiscardedDocumentBackupStore(paths.channelPublishingSettingsDiscardedBackupsDir),
        emptyDocument,
      }),
      store,
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createChannelPublishingSettingsCore, genesisDocument } from "./services";
export type { ChannelPublishingSettingsCore, ServiceDependencies } from "./services";
export * from "./contracts";
