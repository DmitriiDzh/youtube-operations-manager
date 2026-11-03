import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createAutomergeCore, createDiscardedDocumentBackupStore, createFilesystemDocumentStore } from "../automerge-core";
import { createClipReviewsCore, emptyDocument, type ClipReviewsCore } from "./services";
import type { ClipReviewsDocument } from "./contracts";

// BL-241 (ADR 0061): one instance per process (keyed on globalThis, like the other families: the scheduler and the routes are
// compiled separately), so its one-at-a-time queue covers the sync cycle, the Producer's submits and the owner's decisions together.
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.clipReviewsCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: ClipReviewsCore };

export function createClipReviewsCoreForProduction(): ClipReviewsCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const store = createFilesystemDocumentStore(paths.clipReviewsDocDir);
    holder[PRODUCTION_KEY] = createClipReviewsCore({
      core: createAutomergeCore<ClipReviewsDocument>({ store, discardedBackupStore: createDiscardedDocumentBackupStore(paths.clipReviewsDiscardedBackupsDir), emptyDocument }),
      store,
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createClipReviewsCore, genesisDocument, emptyDocument } from "./services";
export type { ClipReviewsCore, ServiceDependencies } from "./services";
export * from "./contracts";
