import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createAutomergeCore, createDiscardedDocumentBackupStore, createFilesystemDocumentStore } from "../automerge-core";
import { createPublishingPlansCore, emptyDocument, type PublishingPlansCore } from "./services";
import type { PublishingPlansDocument } from "./contracts";

// BL-225 (ADR 0051): one instance per process (keyed on globalThis, like the other families: the scheduler and the routes are
// compiled separately), so its one-at-a-time queue covers the sync cycle, the agents' saves and the owner's decisions together.
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.publishingPlansCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: PublishingPlansCore };

export function createPublishingPlansCoreForProduction(): PublishingPlansCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const store = createFilesystemDocumentStore(paths.publishingPlansDocDir);
    holder[PRODUCTION_KEY] = createPublishingPlansCore({
      core: createAutomergeCore<PublishingPlansDocument>({ store, discardedBackupStore: createDiscardedDocumentBackupStore(paths.publishingPlansDiscardedBackupsDir), emptyDocument }),
      store,
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createPublishingPlansCore, genesisDocument, emptyDocument } from "./services";
export type { PublishingPlansCore, ServiceDependencies } from "./services";
export * from "./contracts";
