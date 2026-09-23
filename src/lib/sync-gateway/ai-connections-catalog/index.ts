import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createAutomergeCore, createDiscardedDocumentBackupStore, createFilesystemDocumentStore } from "../automerge-core";
import { createSqlProjectionAdapter } from "./adapters/sql-projection";
import { createSqlSourceAdapter } from "./adapters/sql-source";
import { emptyDocument, createAiConnectionsCatalogCore } from "./services";
import type { AiConnectionsDocument } from "./contracts";

let productionCore: ReturnType<typeof createAiConnectionsCatalogCore> | undefined;

/** Memoized like `change-drafts-sync`'s production core -- not for a single-flight guard here
 * (this module has none of its own), but so every caller shares the SAME underlying
 * `DocumentByteStore`/`AutomergeCore` instance rather than each re-reading the on-disk document
 * fresh, which is merely wasteful, not unsafe, but the shared-instance shape is the established
 * pattern every other production factory in this gateway already follows. */
export function createAiConnectionsCatalogCoreForProduction() {
  if (!productionCore) {
    const paths = getProductionAppPaths();
    const store = createFilesystemDocumentStore(paths.aiConnectionsCatalogDraftsDir);
    productionCore = createAiConnectionsCatalogCore({
      core: createAutomergeCore<AiConnectionsDocument>({
        store,
        discardedBackupStore: createDiscardedDocumentBackupStore(paths.aiConnectionsCatalogDiscardedBackupsDir),
        emptyDocument,
      }),
      store,
      sqlSource: createSqlSourceAdapter(),
      projection: createSqlProjectionAdapter(),
    });
  }
  return productionCore;
}

export { createAiConnectionsCatalogCore } from "./services";
export type { AiConnectionsCatalogCore, ServiceDependencies } from "./services";
export * from "./contracts";
