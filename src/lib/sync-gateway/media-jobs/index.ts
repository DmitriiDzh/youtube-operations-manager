import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFsMediaJobsReportStore } from "./adapters/fs-store";
import { createMediaJobsShareCore, type MediaJobsShareCore } from "./services";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled separately).
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.mediaJobsShareCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: MediaJobsShareCore };

export function createMediaJobsShareCoreForProduction(): MediaJobsShareCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const bootstrap = createBootstrapConfigStore(paths.bootstrapConfigPath);
    holder[PRODUCTION_KEY] = createMediaJobsShareCore({
      store: createFsMediaJobsReportStore(paths.mediaJobsShareDir),
      ownDeviceId: async () => (await bootstrap.ensureExists()).deviceId,
      clock: { now: () => new Date() },
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createMediaJobsShareCore } from "./services";
export type { MediaJobsShareCore, MediaJobsReportStore } from "./services";
export * from "./contracts";
