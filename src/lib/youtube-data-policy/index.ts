import { mkdir } from "node:fs/promises";
import { appDataPaths, getApiDataRetentionStateJson, rawSqlClient, setApiDataRetentionStateJson } from "@/lib/db";
import { copyDatabaseConsistently } from "@/lib/db-backup";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { EMPTY_RETENTION_STATE, runRetentionOnce, type RetentionState } from "./runner";

export * from "./contracts";
export { purgeExpiredApiData, type PurgeResult } from "./services";
export { runRetentionOnce, EMPTY_RETENTION_STATE, type RetentionState, type RetentionDeps } from "./runner";

/** Every 6 hours from the web server's scheduler (`src/instrumentation.ts`) -- so data never outlives 30 days by more than a few hours. */
export const API_DATA_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function getApiDataRetentionState(): Promise<RetentionState> {
  const raw = await getApiDataRetentionStateJson();
  return raw ? { ...EMPTY_RETENTION_STATE, ...(JSON.parse(raw) as Partial<RetentionState>) } : { ...EMPTY_RETENTION_STATE };
}

/** Production wiring of one retention run. */
export async function runApiDataRetention(now: Date = new Date()): Promise<RetentionState> {
  await mkdir(appDataPaths.migrationBackupsDir, { recursive: true });
  return runRetentionOnce(
    {
      client: rawSqlClient,
      backupsDir: appDataPaths.migrationBackupsDir,
      copyDatabase: copyDatabaseConsistently,
      assertMayMutate: assertDeviceAvailableForMutation,
      loadState: getApiDataRetentionState,
      saveState: (state) => setApiDataRetentionStateJson(JSON.stringify(state)),
    },
    now
  );
}
