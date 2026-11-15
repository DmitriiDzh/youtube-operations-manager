import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createAutomergeCore, createDiscardedDocumentBackupStore, createFilesystemDocumentStore } from "../automerge-core";
import { createPackageReviewsCore, emptyDocument, type PackageReviewsCore } from "./services";
import type { PackageReviewsDocument } from "./contracts";

// BL-257 (ADR 0070): one instance per process (keyed on globalThis, like the other families: the scheduler and the routes are
// compiled separately), so its one-at-a-time queue covers the sync cycle, the scans and the owner's decisions together.
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.packageReviewsCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: PackageReviewsCore };

export function createPackageReviewsCoreForProduction(): PackageReviewsCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const store = createFilesystemDocumentStore(paths.packageReviewsDocDir);
    holder[PRODUCTION_KEY] = createPackageReviewsCore({
      core: createAutomergeCore<PackageReviewsDocument>({ store, discardedBackupStore: createDiscardedDocumentBackupStore(paths.packageReviewsDiscardedBackupsDir), emptyDocument }),
      store,
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createPackageReviewsCore, genesisDocument, emptyDocument } from "./services";
export type { PackageReviewsCore, ServiceDependencies } from "./services";
export * from "./contracts";
