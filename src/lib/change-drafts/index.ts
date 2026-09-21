import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFilesystemChangeDraftsStore } from "./adapters/automerge-store";
import { createSqlSourceAdapter } from "./adapters/sql-source";
import { createChangeDraftsCore } from "./services";

export function createChangeDraftsCoreForProduction() {
  const paths = getProductionAppPaths();
  return createChangeDraftsCore({
    store: createFilesystemChangeDraftsStore(paths.changeDraftsDir),
    sqlSource: createSqlSourceAdapter(),
  });
}

export { createChangeDraftsCore } from "./services";
export type { ChangeDraftsCore, ServiceDependencies } from "./services";
export * from "./contracts";
