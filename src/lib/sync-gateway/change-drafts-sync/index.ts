import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChangeDraftsCoreForProduction } from "../change-drafts";
import { createDefaultLogger } from "@/lib/shared-logger";
import { listStoredChannels } from "@/lib/db";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFilesystemTransportAdapter } from "./adapters/filesystem-transport";
import { createChangeDraftsSyncCore, type ChangeDraftsSyncCore } from "./services";

// Memoized, NOT a fresh instance per call (unlike `change-drafts/index.ts`'s own
// `createChangeDraftsCoreForProduction`, which is safely stateless across calls) -- this
// module's `runSyncCycle`/`adoptDivergentPeer` mutual-exclusion guards (`services.ts`) live in
// closure state on one core instance. Every API route in this codebase calls its core factory
// fresh inside the request handler (the established pattern, e.g. `createChangeSetCore()`);
// doing that here would hand each request its own guard state, silently defeating it and
// reopening the exact concurrent-write race on `<deviceId>.automerge` it exists to prevent --
// mirrors `src/app/api/device-handoff/shared.ts`'s own module-level `bootstrapConfigStore`
// singleton for the same reason (shared state that must outlive one request).
//
// This guarantee covers every caller -- `/api/change-drafts/sync`, `/api/change-drafts/
// conflicts-summary`, `/api/channels/[channelId]/change-drafts/adopt-peer`, and (since 2026-10-01)
// the server-side scheduler -- because the instance is held per PROCESS (below). Before that it
// relied on all callers resolving the same module instance. Verified by reasoning about Node.js-runtime module caching
// (this app runs as a persistent `next dev`/`next start` Node server, never as isolated
// per-route serverless functions, where ES module imports of the same resolved path are cached
// once per process regardless of how many files import it) and by the pre-existing, identically-
// shaped `device-handoff/shared.ts` precedent already relying on the same guarantee -- NOT by a
// dedicated cross-route runtime assertion. If this app is ever deployed to a topology that
// isolates each API route into its own module scope (e.g. true serverless functions), this
// singleton -- and the mutual-exclusion it provides -- would silently stop working across routes.
// Memoized on `globalThis`, not in module scope (device-sync cross-system audit, 2026-10-01): the
// server-side scheduler (`src/instrumentation.ts`) is compiled separately from the route handlers,
// so a module-level singleton could give it a DIFFERENT instance -- and a different single-flight
// guard -- than the "adopt peer"/"Sync now" routes, letting a cycle and an adoption write the same
// `<deviceId>.automerge` file at once. One instance per process keeps that exclusion real.
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.changeDraftsSyncCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: ChangeDraftsSyncCore };
const productionHolder = globalThis as GlobalWithInstance;

export function createChangeDraftsSyncCoreForProduction(): ChangeDraftsSyncCore {
  if (!productionHolder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const changeDrafts = createChangeDraftsCoreForProduction();

    productionHolder[PRODUCTION_KEY] = createChangeDraftsSyncCore({
      bootstrapConfig: createBootstrapConfigStore(paths.bootstrapConfigPath),
      localFallbackDir: paths.changeDraftsSyncFallbackDir,
      listChannelIds: async () => (await listStoredChannels()).map((channel) => channel.channelId),
      changeDrafts: {
        exportBytes: changeDrafts.exportBytes,
        mergeIncoming: changeDrafts.mergeIncoming,
        discardLocalAndAdoptPeer: changeDrafts.discardLocalAndAdoptPeer,
      },
      transport: createFilesystemTransportAdapter(),
      logger: createDefaultLogger(),
    });
  }
  return productionHolder[PRODUCTION_KEY];
}

export { createChangeDraftsSyncCore } from "./services";
export type { ChangeDraftsSyncCore, ServiceDependencies } from "./services";
export * from "./contracts";
