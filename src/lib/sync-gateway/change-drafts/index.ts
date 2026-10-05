import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFilesystemChangeDraftsStore } from "./adapters/automerge-store";
import { createDiscardedDocumentBackupStore } from "./adapters/discarded-backup-store";
import { createDefaultLogger } from "@/lib/shared-logger";
import { createSqlProjectionAdapter } from "./adapters/sql-projection";
import { createSqlSourceAdapter } from "./adapters/sql-source";
import { createChangeDraftsCore } from "./services";

export function createChangeDraftsCoreForProduction() {
  const paths = getProductionAppPaths();
  return createChangeDraftsCore({
    store: createFilesystemChangeDraftsStore(paths.changeDraftsDir),
    sqlSource: createSqlSourceAdapter(),
    projection: createSqlProjectionAdapter(),
    discardedBackupStore: createDiscardedDocumentBackupStore(paths.changeDraftsDiscardedBackupsDir),
    logger: createDefaultLogger(),
  });
}

export { createChangeDraftsCore } from "./services";
export type { ChangeDraftsCore, ServiceDependencies } from "./services";
export * from "./contracts";
