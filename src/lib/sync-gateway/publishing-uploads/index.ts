import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFsPublishingUploadsReportStore } from "./adapters/fs-store";
import { createPublishingUploadsShareCore, type PublishingUploadsShareCore } from "./services";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled separately).
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.publishingUploadsShareCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: PublishingUploadsShareCore };

export function createPublishingUploadsShareCoreForProduction(): PublishingUploadsShareCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const bootstrap = createBootstrapConfigStore(paths.bootstrapConfigPath);
    holder[PRODUCTION_KEY] = createPublishingUploadsShareCore({
      store: createFsPublishingUploadsReportStore(paths.publishingUploadsShareDir),
      ownDeviceId: async () => (await bootstrap.ensureExists()).deviceId,
      clock: { now: () => new Date() },
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createPublishingUploadsShareCore } from "./services";
export type { PublishingUploadsShareCore, PublishingUploadsReportStore } from "./services";
export * from "./contracts";
