import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFilesystemChangeDraftsStore } from "./adapters/automerge-store";
import { createChangeDraftsCore } from "./services";

export function createChangeDraftsCoreForProduction() {
  const paths = getProductionAppPaths();
  return createChangeDraftsCore({ store: createFilesystemChangeDraftsStore(paths.changeDraftsDir) });
}

export { createChangeDraftsCore } from "./services";
export type { ChangeDraftsCore, ServiceDependencies } from "./services";
export * from "./contracts";
