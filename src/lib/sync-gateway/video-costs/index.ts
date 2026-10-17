import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFsVideoCostsReportStore } from "./adapters/fs-store";
import { createVideoCostsShareCore, type VideoCostsShareCore } from "./services";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled separately).
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.videoCostsShareCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: VideoCostsShareCore };

export function createVideoCostsShareCoreForProduction(): VideoCostsShareCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const bootstrap = createBootstrapConfigStore(paths.bootstrapConfigPath);
    holder[PRODUCTION_KEY] = createVideoCostsShareCore({
      store: createFsVideoCostsReportStore(paths.videoCostsShareDir),
      ownDeviceId: async () => (await bootstrap.ensureExists()).deviceId,
      clock: { now: () => new Date() },
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createVideoCostsShareCore } from "./services";
export type { VideoCostsShareCore, VideoCostsReportStore } from "./services";
export * from "./contracts";
