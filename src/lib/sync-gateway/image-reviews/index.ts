import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createAutomergeCore, createDiscardedDocumentBackupStore, createFilesystemDocumentStore } from "../automerge-core";
import { createImageReviewsCore, emptyDocument, type ImageReviewsCore } from "./services";
import type { ImageReviewsDocument } from "./contracts";

// BL-272 (ADR 0076): one instance per process (keyed on globalThis, like the other families: the scheduler and the routes are
// compiled separately), so its one-at-a-time queue covers the sync cycle, the Producer's submits and the owner's decisions together.
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.imageReviewsCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: ImageReviewsCore };

export function createImageReviewsCoreForProduction(): ImageReviewsCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const store = createFilesystemDocumentStore(paths.imageReviewsDocDir);
    holder[PRODUCTION_KEY] = createImageReviewsCore({
      core: createAutomergeCore<ImageReviewsDocument>({ store, discardedBackupStore: createDiscardedDocumentBackupStore(paths.imageReviewsDiscardedBackupsDir), emptyDocument }),
      store,
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createImageReviewsCore, genesisDocument, emptyDocument } from "./services";
export type { ImageReviewsCore, ServiceDependencies } from "./services";
export * from "./contracts";
