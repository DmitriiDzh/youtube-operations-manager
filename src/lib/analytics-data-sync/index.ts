import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { appDataPaths, exportAnalyticsShareRows, importAnalyticsShareRows } from "@/lib/db";
import { createAnalyticsDataSync, type AnalyticsDataSync } from "./services";

// One instance per process (globalThis: the scheduler and the routes are compiled separately), so its "already imported"
// memory and single import pass are shared.
const KEY = Symbol.for("ytom.analyticsDataSync");
type GlobalWithInstance = typeof globalThis & { [KEY]?: AnalyticsDataSync };

export function getAnalyticsDataSync(): AnalyticsDataSync {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[KEY]) {
    const store = createBootstrapConfigStore(appDataPaths.bootstrapConfigPath);
    holder[KEY] = createAnalyticsDataSync({
      async getConfig() {
        const config = await store.ensureExists();
        return { deviceId: config.deviceId, folder: config.syncthingRootPath ?? null };
      },
      exportRows: (from, to) => exportAnalyticsShareRows(from, to),
      importRows: (tables) => importAnalyticsShareRows(tables),
      clock: { now: () => new Date() },
      log: (message) => console.warn(message),
    });
  }
  return holder[KEY];
}

/** BL-151: how long a collection waits for the other computer's rows to be imported before collecting anyway. */
const PEER_IMPORT_TIMEOUT_MS = 30_000;

/**
 * The other devices' rows first (AC-AD-01/03): a channel they collected (or checked) recently then counts as current here.
 * Never fails a collection: an unreachable folder or a slow import means "collect locally, as before" (AC-AD-05).
 * Returns the number of peer files imported.
 */
export async function importPeersFirst(): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<number>((resolve) => (timer = setTimeout(() => resolve(0), PEER_IMPORT_TIMEOUT_MS)));
  try {
    return await Promise.race([getAnalyticsDataSync().importPeers().then((o) => o.imported.length), timeout]);
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

export { ANALYTICS_DATA_DIR_NAME } from "./contracts";
export type { AnalyticsDataSync, ImportOutcome } from "./services";
