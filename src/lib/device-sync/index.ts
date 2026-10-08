import path from "node:path";
import { type Client } from "@libsql/client";
import { createLibsqlClient, SQLITE_BUSY_TIMEOUT_MS } from "@/lib/libsql-client";
import {
  appDataPaths,
  getDeviceAutoSyncEnabled,
  getDeviceSyncStatusJson,
  SCHEMA_CURRENT_VERSION,
  setDeviceSyncStatusJson,
} from "@/lib/db";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getOperationRegistry } from "@/lib/operation-progress";
import { EMPTY_DEVICE_SYNC_STATUS, type DeviceSyncStatus } from "./contracts";
import { createDeviceSyncRunner, type DeviceSyncRunner } from "./services";

export * from "./contracts";
export { ancestryOf, backgroundWriteVerdict, decideSyncAction, type BackgroundWriteVerdict, type DeviceSyncRunner } from "./services";

// Process-wide, keyed on `globalThis` (review round 1): Next.js compiles `instrumentation.ts` (the
// scheduler) separately from the route handlers, so a module-level singleton could give "Sync now"
// its own runner -- with its own action queue -- next to the scheduler's.
const RUNNER_KEY = Symbol.for("ytom.deviceSync.runner");
type GlobalWithRunner = typeof globalThis & { [RUNNER_KEY]?: DeviceSyncRunner };

/**
 * A DEDICATED connection, not the shared `rawSqlClient`: an import runs one `BEGIN IMMEDIATE`
 * transaction, and on the shared connection any unrelated write issued meanwhile by another part
 * of this process (the Live-writes lease renewal, a draft sync cycle that started just before the
 * lock) would silently JOIN that transaction -- and be rolled back with it if the import failed.
 * On its own connection, such a write simply waits for the busy timeout like any other writer.
 */
function createDedicatedClient(): Client {
  const client = createLibsqlClient({ url: `file:${appDataPaths.dbPath}` });
  void client.execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`).catch(() => undefined);
  return client;
}

/**
 * The production runner (DEVICE_AUTO_SYNC_PLAN.md). Automatic sync only ever uses the operator's
 * configured Syncthing folder -- never the local fallback directory manual export uses, which no
 * other computer can see.
 */
export function getDeviceSyncRunner(): DeviceSyncRunner {
  const g = globalThis as GlobalWithRunner;
  const existing = g[RUNNER_KEY];
  if (existing) return existing;
  const bootstrapConfigStore = createBootstrapConfigStore(appDataPaths.bootstrapConfigPath);
  const runner = createDeviceSyncRunner({
    client: createDedicatedClient(),
    currentSchemaVersion: SCHEMA_CURRENT_VERSION,
    resolveConfig: async () => {
      const config = await bootstrapConfigStore.ensureExists();
      return { deviceId: config.deviceId, folder: config.syncthingRootPath ?? null };
    },
    migrationBackupsDir: appDataPaths.migrationBackupsDir,
    workingDir: path.join(appDataPaths.appDataDir, "import-work"),
    isEnabled: getDeviceAutoSyncEnabled,
    loadStatus: async () => {
      const raw = await getDeviceSyncStatusJson();
      if (!raw) return { ...EMPTY_DEVICE_SYNC_STATUS };
      return { ...EMPTY_DEVICE_SYNC_STATUS, ...(JSON.parse(raw) as Partial<DeviceSyncStatus>) };
    },
    saveStatus: (status) => setDeviceSyncStatusJson(JSON.stringify(status)),
    // A running server-side write (Fix all) must not be aborted by an automatic export's operation lock.
    hasActiveLocalOperation: () => getOperationRegistry().hasActive(),
  });
  g[RUNNER_KEY] = runner;
  return runner;
}
