import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createAutomergeCore, createDiscardedDocumentBackupStore, createFilesystemDocumentStore } from "../automerge-core";
import { createSqlProjectionAdapter } from "./adapters/sql-projection";
import { createSqlSourceAdapter } from "./adapters/sql-source";
import { emptyProfile, createEditorialProfileCore } from "./services";
import type { EditorialProfileDocument } from "./contracts";

export function createEditorialProfileCoreForProduction() {
  const paths = getProductionAppPaths();
  return createEditorialProfileCore({
    core: createAutomergeCore<EditorialProfileDocument>({
      store: createFilesystemDocumentStore(paths.editorialProfileDraftsDir),
      discardedBackupStore: createDiscardedDocumentBackupStore(paths.editorialProfileDiscardedBackupsDir),
      emptyDocument: emptyProfile,
    }),
    sqlSource: createSqlSourceAdapter(),
    projection: createSqlProjectionAdapter(),
  });
}

export { createEditorialProfileCore } from "./services";
export type { EditorialProfileCore, ServiceDependencies } from "./services";
export * from "./contracts";
