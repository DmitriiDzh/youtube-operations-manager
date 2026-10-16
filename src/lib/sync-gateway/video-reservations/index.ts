import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFsVideoReservationsReportStore } from "./adapters/fs-store";
import { createVideoReservationsShareCore, type VideoReservationsShareCore } from "./services";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled separately).
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.videoReservationsShareCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: VideoReservationsShareCore };

export function createVideoReservationsShareCoreForProduction(): VideoReservationsShareCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const bootstrap = createBootstrapConfigStore(paths.bootstrapConfigPath);
    holder[PRODUCTION_KEY] = createVideoReservationsShareCore({
      store: createFsVideoReservationsReportStore(paths.videoReservationsShareDir),
      ownDeviceId: async () => (await bootstrap.ensureExists()).deviceId,
      clock: { now: () => new Date() },
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createVideoReservationsShareCore } from "./services";
export type { VideoReservationsShareCore, VideoReservationsReportStore } from "./services";
export * from "./contracts";
