import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "@/lib/db-backup/contracts";
import { readdir } from "node:fs/promises";
import { purgeExpiredApiData, scrubBackupFile, type PurgeHooks, type PurgeResult } from "./services";

export type RetentionState = {
  /** The one-time backup taken before the very first purge (AC-P13-07). */
  firstBackupPath: string | null;
  lastRunAt: string | null;
  lastResult: PurgeResult | null;
  lastError: string | null;
  /** Backup files whose expired API rows were scrubbed on the last run (owner msg 1139, item 2). */
  lastBackupsScrubbed?: number;
};

export const EMPTY_RETENTION_STATE: RetentionState = {
  firstBackupPath: null,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
};

export type RetentionDeps = {
  client: SqlExecutor;
  backupsDir: string;
  copyDatabase: (client: SqlExecutor, destPath: string) => Promise<unknown>;
  /** The app-wide pre-mutation gate (operation lock / recovery mode). Throws when mutation is not allowed. */
  assertMayMutate: (client: SqlExecutor) => Promise<void>;
  loadState: () => Promise<RetentionState>;
  saveState: (state: RetentionState) => Promise<void>;
  /** Inside the purge transaction (production: keep a clean device clean for device sync). */
  purgeHooks?: PurgeHooks;
};

/**
 * One run of the retention job (Phase 13 slice 13.2). Never throws: the outcome is recorded. Skips
 * (without error) while the device may not mutate. Before the FIRST purge ever, a full backup is
 * taken -- the data this deletes was collected before the policy was applied, and the owner should
 * be able to look at it once more if needed.
 */
export async function runRetentionOnce(deps: RetentionDeps, now: Date = new Date()): Promise<RetentionState> {
  let state: RetentionState;
  try {
    state = { ...EMPTY_RETENTION_STATE, ...(await deps.loadState()) };
  } catch {
    state = { ...EMPTY_RETENTION_STATE };
  }
  try {
    await deps.assertMayMutate(deps.client);
  } catch {
    return state; // paused (lock or recovery); the next run tries again
  }
  try {
    if (!state.firstBackupPath) {
      const backupPath = path.join(deps.backupsDir, `pre-api-retention-${Date.now()}-${randomUUID().slice(0, 8)}.db`);
      await deps.copyDatabase(deps.client, backupPath);
      state = { ...state, firstBackupPath: backupPath };
      await deps.saveState(state);
    }
    const result = await purgeExpiredApiData(deps.client, now, deps.purgeHooks ?? {});
    // Owner msg 1139, item 2: the backups follow the 30-day rule too (scrubbed, not deleted).
    let scrubbed = 0;
    for (const name of (await readdir(deps.backupsDir).catch(() => [] as string[])).filter((n) => n.endsWith(".db"))) {
      try {
        if ((await scrubBackupFile(`${deps.backupsDir}/${name}`, now)).changed) scrubbed += 1;
      } catch {
        // One unreadable backup never stops the others; it is retried next run.
      }
    }
    state = { ...state, lastRunAt: now.toISOString(), lastResult: result, lastError: null, lastBackupsScrubbed: scrubbed };
  } catch (error) {
    state = { ...state, lastRunAt: now.toISOString(), lastError: error instanceof Error ? error.message : String(error) };
  }
  await deps.saveState(state).catch(() => undefined);
  return state;
}
