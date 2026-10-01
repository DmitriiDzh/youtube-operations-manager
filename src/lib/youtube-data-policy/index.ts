import { mkdir } from "node:fs/promises";
import { createClient, type Client } from "@libsql/client";
import { appDataPaths, getApiDataRetentionStateJson, setApiDataRetentionStateJson } from "@/lib/db";
import { copyDatabaseConsistently } from "@/lib/db-backup";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { computeContentFingerprint, rebaselineLineageFingerprintIfUnchanged } from "@/lib/snapshot";
import { EMPTY_RETENTION_STATE, runRetentionOnce, type RetentionState } from "./runner";

export * from "./contracts";
export { purgeExpiredApiData, type PurgeResult, type PurgeHooks } from "./services";
export { runRetentionOnce, EMPTY_RETENTION_STATE, type RetentionState, type RetentionDeps } from "./runner";

/** Every 6 hours from the web server's scheduler (`src/instrumentation.ts`) -- so data never outlives 30 days by more than a few hours. */
export const API_DATA_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function getApiDataRetentionState(): Promise<RetentionState> {
  const raw = await getApiDataRetentionStateJson();
  return raw ? { ...EMPTY_RETENTION_STATE, ...(JSON.parse(raw) as Partial<RetentionState>) } : { ...EMPTY_RETENTION_STATE };
}

let dedicated: Client | null = null;
/** Review round 1: the purge's transaction runs on its own connection, never the shared one. */
function dedicatedClient(): Client {
  if (!dedicated) {
    dedicated = createClient({ url: `file:${appDataPaths.dbPath}` });
    void dedicated.execute("PRAGMA busy_timeout = 5000").catch(() => undefined);
  }
  return dedicated;
}

/** Production wiring of one retention run. */
export async function runApiDataRetention(now: Date = new Date()): Promise<RetentionState> {
  await mkdir(appDataPaths.migrationBackupsDir, { recursive: true });
  const client = dedicatedClient();
  // Review round 1 (#2): every computer applies the same time-based expiry, so expiring rows are not
  // a local change to publish. If the device was in sync before the purge (its content equalled the
  // fingerprint recorded with its lineage head), it stays in sync after it -- inside the same
  // transaction, by compare-and-set, so a concurrent real change still reads as unpublished.
  let before: string | null = null;
  return runRetentionOnce(
    {
      client,
      backupsDir: appDataPaths.migrationBackupsDir,
      copyDatabase: copyDatabaseConsistently,
      assertMayMutate: assertDeviceAvailableForMutation,
      loadState: getApiDataRetentionState,
      saveState: (state) => setApiDataRetentionStateJson(JSON.stringify(state)),
      purgeHooks: {
        beforePurge: async () => {
          before = await computeContentFingerprint(client);
        },
        afterPurge: async () => {
          if (before) await rebaselineLineageFingerprintIfUnchanged(client, before, await computeContentFingerprint(client));
        },
      },
    },
    now
  );
}
