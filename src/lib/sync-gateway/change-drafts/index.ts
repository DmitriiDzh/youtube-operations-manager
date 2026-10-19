import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFilesystemChangeDraftsStore } from "./adapters/automerge-store";
import { createDiscardedDocumentBackupStore } from "./adapters/discarded-backup-store";
import { createDefaultLogger } from "@/lib/shared-logger";
import { createSqlProjectionAdapter } from "./adapters/sql-projection";
import { createSqlSourceAdapter } from "./adapters/sql-source";
import { createChangeDraftsCore } from "./services";
import { createChangeDraftsCache, type ChangeDraftsCache } from "./cache";

// BL-203: one cache per process, shared by every core -- the sync cycle and each route build a new core per call, so a per-core
// cache would be empty every time. `globalThis` keeps it single across the server's module instances.
const CACHE_KEY = Symbol.for("ytom.changeDrafts.cache");
function processCache(): ChangeDraftsCache {
  const g = globalThis as typeof globalThis & { [CACHE_KEY]?: ChangeDraftsCache };
  return (g[CACHE_KEY] ??= createChangeDraftsCache());
}

export function createChangeDraftsCoreForProduction() {
  const paths = getProductionAppPaths();
  return createChangeDraftsCore({
    store: createFilesystemChangeDraftsStore(paths.changeDraftsDir),
    sqlSource: createSqlSourceAdapter(),
    projection: createSqlProjectionAdapter(),
    discardedBackupStore: createDiscardedDocumentBackupStore(paths.changeDraftsDiscardedBackupsDir),
    logger: createDefaultLogger(),
    cache: processCache(),
  });
}

export { createChangeDraftsCore } from "./services";
export type { ChangeDraftsCore, ServiceDependencies } from "./services";
export * from "./contracts";
