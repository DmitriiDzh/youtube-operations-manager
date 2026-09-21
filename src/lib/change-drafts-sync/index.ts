import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChangeDraftsCoreForProduction } from "@/lib/change-drafts";
import { createDefaultLogger } from "@/lib/channel-sync/adapters/logger";
import { listStoredChannels } from "@/lib/db";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFilesystemTransportAdapter } from "./adapters/filesystem-transport";
import { createChangeDraftsSyncCore, type ChangeDraftsSyncCore } from "./services";

// Memoized, NOT a fresh instance per call (unlike `change-drafts/index.ts`'s own
// `createChangeDraftsCoreForProduction`, which is safely stateless across calls) -- this
// module's `runSyncCycle` single-flight guard (`services.ts`) lives in closure state on one core
// instance. Every API route in this codebase calls its core factory fresh inside the request
// handler (the established pattern, e.g. `createChangeSetCore()`); doing that here would hand
// each request its own `inFlight` variable, silently defeating the guard and reopening the exact
// concurrent-write race on `<deviceId>.automerge` it exists to prevent -- mirrors
// `src/app/api/device-handoff/shared.ts`'s own module-level `bootstrapConfigStore` singleton for
// the same reason (shared state that must outlive one request).
let productionCore: ChangeDraftsSyncCore | undefined;

export function createChangeDraftsSyncCoreForProduction(): ChangeDraftsSyncCore {
  if (!productionCore) {
    const paths = getProductionAppPaths();
    const changeDrafts = createChangeDraftsCoreForProduction();

    productionCore = createChangeDraftsSyncCore({
      bootstrapConfig: createBootstrapConfigStore(paths.bootstrapConfigPath),
      localFallbackDir: paths.changeDraftsSyncFallbackDir,
      listChannelIds: async () => (await listStoredChannels()).map((channel) => channel.channelId),
      changeDrafts: {
        exportBytes: changeDrafts.exportBytes,
        mergeIncoming: changeDrafts.mergeIncoming,
      },
      transport: createFilesystemTransportAdapter(),
      logger: createDefaultLogger(),
    });
  }
  return productionCore;
}

export { createChangeDraftsSyncCore } from "./services";
export type { ChangeDraftsSyncCore, ServiceDependencies } from "./services";
export * from "./contracts";
