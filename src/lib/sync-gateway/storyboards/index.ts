import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createAutomergeCore, createDiscardedDocumentBackupStore, createFilesystemDocumentStore } from "../automerge-core";
import { createStoryboardsCore, emptyDocument, type StoryboardsCore } from "./services";
import type { StoryboardsDocument } from "./contracts";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled
// separately), so its one-at-a-time queue covers the sync cycle, the Factory API's writes and the owner's actions together.
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.storyboardsCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: StoryboardsCore };

export function createStoryboardsCoreForProduction(): StoryboardsCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const store = createFilesystemDocumentStore(paths.storyboardsDocDir);
    holder[PRODUCTION_KEY] = createStoryboardsCore({
      core: createAutomergeCore<StoryboardsDocument>({ store, discardedBackupStore: createDiscardedDocumentBackupStore(paths.storyboardsDiscardedBackupsDir), emptyDocument }),
      store,
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createStoryboardsCore, genesisDocument } from "./services";
export type { StoryboardsCore, ServiceDependencies } from "./services";
export * from "./contracts";
