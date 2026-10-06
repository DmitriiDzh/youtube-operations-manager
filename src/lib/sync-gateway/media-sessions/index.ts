import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFsMediaSessionsReportStore } from "./adapters/fs-store";
import { createMediaSessionsShareCore, type MediaSessionsShareCore } from "./services";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled separately).
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.mediaSessionsShareCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: MediaSessionsShareCore };

export function createMediaSessionsShareCoreForProduction(): MediaSessionsShareCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const bootstrap = createBootstrapConfigStore(paths.bootstrapConfigPath);
    holder[PRODUCTION_KEY] = createMediaSessionsShareCore({
      store: createFsMediaSessionsReportStore(paths.mediaSessionsShareDir),
      ownDeviceId: async () => (await bootstrap.ensureExists()).deviceId,
      clock: { now: () => new Date() },
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createMediaSessionsShareCore } from "./services";
export type { MediaSessionsShareCore, MediaSessionsReportStore } from "./services";
export * from "./contracts";
