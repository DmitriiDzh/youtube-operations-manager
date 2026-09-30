import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import {
  appDataPaths,
  getDeviceAutoSyncEnabled,
  getDeviceSyncStatusJson,
  SCHEMA_CURRENT_VERSION,
  setDeviceSyncStatusJson,
} from "@/lib/db";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { EMPTY_DEVICE_SYNC_STATUS, type DeviceSyncStatus } from "./contracts";
import { createDeviceSyncRunner, type DeviceSyncRunner } from "./services";

export * from "./contracts";
export { ancestryOf, decideSyncAction, type DeviceSyncRunner } from "./services";

let runner: DeviceSyncRunner | null = null;

/**
 * A DEDICATED connection, not the shared `rawSqlClient`: an import runs one `BEGIN IMMEDIATE`
 * transaction, and on the shared connection any unrelated write issued meanwhile by another part
 * of this process (the Live-writes lease renewal, a draft sync cycle that started just before the
 * lock) would silently JOIN that transaction -- and be rolled back with it if the import failed.
 * On its own connection, such a write simply waits for the busy timeout like any other writer.
 */
function createDedicatedClient(): Client {
  const client = createClient({ url: `file:${appDataPaths.dbPath}` });
  void client.execute("PRAGMA busy_timeout = 5000").catch(() => undefined);
  return client;
}

/**
 * The production runner (DEVICE_AUTO_SYNC_PLAN.md). Automatic sync only ever uses the operator's
 * configured Syncthing folder -- never the local fallback directory manual export uses, which no
 * other computer can see.
 */
export function getDeviceSyncRunner(): DeviceSyncRunner {
  if (runner) return runner;
  const bootstrapConfigStore = createBootstrapConfigStore(appDataPaths.bootstrapConfigPath);
  runner = createDeviceSyncRunner({
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
  });
  return runner;
}
