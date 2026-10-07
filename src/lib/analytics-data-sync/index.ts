import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { appDataPaths, countStoredVideos, exportAnalyticsShareRows, getAnalyticsShareImportedJson, importAnalyticsShareRows, setAnalyticsShareImportedJson } from "@/lib/db";
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
      async loadSeen() {
        const text = await getAnalyticsShareImportedJson();
        return text ? (JSON.parse(text) as Record<string, string>) : {};
      },
      saveSeen: (seen) => setAnalyticsShareImportedJson(JSON.stringify(seen)),
      localVideoCount: () => countStoredVideos(),
      clock: { now: () => new Date() },
      log: (message) => console.warn(message),
    });
  }
  return holder[KEY];
}

/** BL-151: how long a collection waits for the other computer's rows before giving up on this load's collection. */
const PEER_IMPORT_WAIT_MS = 120_000;

/**
 * The other devices' rows first (AC-AD-01/03): a channel they collected (or checked) recently then counts as current here.
 * - Never fails a collection: an unreachable folder means "collect locally, as before" (AC-AD-05), `{ pending: false }`.
 * - An import still running after the wait means `{ pending: true }`: the caller must NOT collect now (it would race the import
 *   and judge staleness on half-imported data; plan: "the collection waits for the next load").
 */
export async function importPeersFirst(): Promise<{ imported: number; pending: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), PEER_IMPORT_WAIT_MS)));
  try {
    const result = await Promise.race([getAnalyticsDataSync().importPeers(), timeout]);
    return result === "timeout" ? { imported: 0, pending: true } : { imported: result.imported.length, pending: false };
  } catch {
    return { imported: 0, pending: false };
  } finally {
    clearTimeout(timer);
  }
}

export { ANALYTICS_DATA_DIR_NAME } from "./contracts";
export type { AnalyticsDataSync, ImportOutcome } from "./services";
