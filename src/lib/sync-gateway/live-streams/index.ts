import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFsLiveStreamsReportStore } from "./adapters/fs-store";
import { createLiveStreamsShareCore, type LiveStreamsShareCore } from "./services";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled separately).
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.liveStreamsShareCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: LiveStreamsShareCore };

export function createLiveStreamsShareCoreForProduction(): LiveStreamsShareCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const bootstrap = createBootstrapConfigStore(paths.bootstrapConfigPath);
    holder[PRODUCTION_KEY] = createLiveStreamsShareCore({
      store: createFsLiveStreamsReportStore(paths.liveStreamsShareDir),
      ownDeviceId: async () => (await bootstrap.ensureExists()).deviceId,
      clock: { now: () => new Date() },
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createLiveStreamsShareCore } from "./services";
export type { LiveStreamsShareCore, LiveStreamsReportStore } from "./services";
export * from "./contracts";
