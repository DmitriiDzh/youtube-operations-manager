import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFsGeminiSpendReportStore } from "./adapters/fs-store";
import { createGeminiSpendShareCore, type GeminiSpendShareCore } from "./services";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled separately).
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.geminiSpendShareCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: GeminiSpendShareCore };

export function createGeminiSpendShareCoreForProduction(): GeminiSpendShareCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const bootstrap = createBootstrapConfigStore(paths.bootstrapConfigPath);
    holder[PRODUCTION_KEY] = createGeminiSpendShareCore({
      store: createFsGeminiSpendReportStore(paths.geminiSpendShareDir),
      ownDeviceId: async () => (await bootstrap.ensureExists()).deviceId,
      clock: { now: () => new Date() },
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createGeminiSpendShareCore } from "./services";
export type { GeminiSpendShareCore, GeminiSpendReportStore } from "./services";
export * from "./contracts";
