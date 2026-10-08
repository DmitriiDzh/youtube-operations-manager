import { mkdir } from "node:fs/promises";
import { type Client } from "@libsql/client";
import { createLibsqlClient, SQLITE_BUSY_TIMEOUT_MS } from "@/lib/libsql-client";
import { appDataPaths, getApiDataRetentionStateJson, setApiDataRetentionStateJson } from "@/lib/db";
import { copyDatabaseConsistently } from "@/lib/db-backup";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { computeContentFingerprint, rebaselineLineageFingerprintIfUnchanged } from "@/lib/snapshot";
import { EMPTY_RETENTION_STATE, runRetentionOnce, type RetentionState } from "./runner";
import type { PurgeHooks } from "./services";
import type { SqlExecutor } from "@/lib/db-backup/contracts";

export * from "./contracts";
export { purgeExpiredApiData, purgeExpiredApiDataWithinTransaction, scrubBackupFile, type PurgeResult, type PurgeHooks } from "./services";
export { runRetentionOnce, EMPTY_RETENTION_STATE, type RetentionState, type RetentionDeps } from "./runner";

/** Every 6 hours from the web server's scheduler (`src/instrumentation.ts`) -- so data never outlives 30 days by more than a few hours. */
export const API_DATA_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function getApiDataRetentionState(): Promise<RetentionState> {
  const raw = await getApiDataRetentionStateJson();
  return raw ? { ...EMPTY_RETENTION_STATE, ...(JSON.parse(raw) as Partial<RetentionState>) } : { ...EMPTY_RETENTION_STATE };
}

const DEDICATED_KEY = Symbol.for("ytom.youtubeDataPolicy.dedicatedClient");
type GlobalWithClient = typeof globalThis & { [DEDICATED_KEY]?: Client };
/** Review round 1: the purge's transaction runs on its own connection, never the shared one --
 * held per process on `globalThis` (like device-sync's), so reloads/bundles share one handle. */
function dedicatedClient(): Client {
  const g = globalThis as GlobalWithClient;
  if (!g[DEDICATED_KEY]) {
    const client = createLibsqlClient({ url: `file:${appDataPaths.dbPath}` });
    void client.execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`).catch(() => undefined);
    // Review round 6: purged rows are overwritten on disk, not left in free pages.
    void client.execute("PRAGMA secure_delete = ON").catch(() => undefined);
    g[DEDICATED_KEY] = client;
  }
  return g[DEDICATED_KEY];
}

/**
 * Review round 1 (#2): every computer applies the same time-based expiry, so expiring rows are not
 * a local change to publish. If the device was in sync before the purge (its content equalled the
 * fingerprint recorded with its lineage head), it stays in sync after it -- inside the purge's own
 * transaction, by compare-and-set, so a concurrent real change still reads as unpublished. Exported
 * so tests exercise exactly the production hooks.
 */
export function createSyncPreservingPurgeHooks(client: SqlExecutor): PurgeHooks {
  let before: string | null = null;
  return {
    beforePurge: async () => {
      before = await computeContentFingerprint(client);
    },
    afterPurge: async () => {
      if (before) await rebaselineLineageFingerprintIfUnchanged(client, before, await computeContentFingerprint(client));
    },
  };
}

/** Production wiring of one retention run. */
export async function runApiDataRetention(now: Date = new Date()): Promise<RetentionState> {
  await mkdir(appDataPaths.migrationBackupsDir, { recursive: true });
  const client = dedicatedClient();
  return runRetentionOnce(
    {
      client,
      backupsDir: appDataPaths.migrationBackupsDir,
      copyDatabase: copyDatabaseConsistently,
      assertMayMutate: assertDeviceAvailableForMutation,
      loadState: getApiDataRetentionState,
      saveState: (state) => setApiDataRetentionStateJson(JSON.stringify(state)),
      purgeHooks: createSyncPreservingPurgeHooks(client),
    },
    now
  );
}
