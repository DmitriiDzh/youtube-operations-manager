import path from "node:path";
import {
  appDataPaths,
  getDeviceAutoSyncEnabled,
  getDeviceSyncStatusJson,
  rawSqlClient,
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
 * The production runner (DEVICE_AUTO_SYNC_PLAN.md). Automatic sync only ever uses the operator's
 * configured Syncthing folder -- never the local fallback directory manual export uses, which no
 * other computer can see.
 */
export function getDeviceSyncRunner(): DeviceSyncRunner {
  if (runner) return runner;
  const bootstrapConfigStore = createBootstrapConfigStore(appDataPaths.bootstrapConfigPath);
  runner = createDeviceSyncRunner({
    client: rawSqlClient,
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
