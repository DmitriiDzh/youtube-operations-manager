import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFsLiveAnalyticsReportStore } from "./adapters/fs-store";
import { createLiveAnalyticsShareCore, type LiveAnalyticsShareCore } from "./services";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled separately).
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.liveAnalyticsShareCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: LiveAnalyticsShareCore };

export function createLiveAnalyticsShareCoreForProduction(): LiveAnalyticsShareCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const bootstrap = createBootstrapConfigStore(paths.bootstrapConfigPath);
    holder[PRODUCTION_KEY] = createLiveAnalyticsShareCore({
      store: createFsLiveAnalyticsReportStore(paths.liveAnalyticsShareDir),
      ownDeviceId: async () => (await bootstrap.ensureExists()).deviceId,
      clock: { now: () => new Date() },
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createLiveAnalyticsShareCore } from "./services";
export type { LiveAnalyticsShareCore, LiveAnalyticsReportStore } from "./services";
export * from "./contracts";
