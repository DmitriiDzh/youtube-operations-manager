import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFsElevenlabsSpendReportStore } from "./adapters/fs-store";
import { createElevenlabsSpendShareCore, type ElevenlabsSpendShareCore } from "./services";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled separately).
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.elevenlabsSpendShareCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: ElevenlabsSpendShareCore };

export function createElevenlabsSpendShareCoreForProduction(): ElevenlabsSpendShareCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const bootstrap = createBootstrapConfigStore(paths.bootstrapConfigPath);
    holder[PRODUCTION_KEY] = createElevenlabsSpendShareCore({
      store: createFsElevenlabsSpendReportStore(paths.elevenlabsSpendShareDir),
      ownDeviceId: async () => (await bootstrap.ensureExists()).deviceId,
      clock: { now: () => new Date() },
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createElevenlabsSpendShareCore } from "./services";
export type { ElevenlabsSpendShareCore, ElevenlabsSpendReportStore } from "./services";
export * from "./contracts";
