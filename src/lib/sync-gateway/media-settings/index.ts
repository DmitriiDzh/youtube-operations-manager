import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createAutomergeCore, createDiscardedDocumentBackupStore, createFilesystemDocumentStore } from "../automerge-core";
import { createMediaSettingsCore, emptyDocument, type MediaSettingsCore } from "./services";
import type { MediaSettingsDocument } from "./contracts";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled separately).
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.mediaSettingsCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: MediaSettingsCore };

export function createMediaSettingsCoreForProduction(): MediaSettingsCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const store = createFilesystemDocumentStore(paths.mediaSettingsDocDir);
    holder[PRODUCTION_KEY] = createMediaSettingsCore({
      core: createAutomergeCore<MediaSettingsDocument>({
        store,
        discardedBackupStore: createDiscardedDocumentBackupStore(paths.mediaSettingsDiscardedBackupsDir),
        emptyDocument,
      }),
      store,
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createMediaSettingsCore, genesisDocument, scanForConflicts } from "./services";
export type { MediaSettingsCore, ServiceDependencies } from "./services";
export * from "./contracts";
