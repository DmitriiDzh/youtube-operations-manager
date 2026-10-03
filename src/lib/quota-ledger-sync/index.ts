import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { appDataPaths, listAllQuotaCalls } from "@/lib/db";
import { createQuotaLedgerSyncServices } from "./services";

let core: ReturnType<typeof createQuotaLedgerSyncServices> | null = null;

/** One instance per process: it remembers what it last published so an unchanged log is not rewritten every tick. */
export function getQuotaLedgerSyncCore() {
  if (core) return core;
  const store = createBootstrapConfigStore(appDataPaths.bootstrapConfigPath);
  core = createQuotaLedgerSyncServices({
    async getConfig() {
      const config = await store.ensureExists();
      return { deviceId: config.deviceId, folder: config.syncthingRootPath ?? null };
    },
    listLocalCalls: (sinceSeconds) => listAllQuotaCalls(sinceSeconds),
    clock: { now: () => new Date() },
  });
  return core;
}

export type QuotaLedgerSyncCore = ReturnType<typeof getQuotaLedgerSyncCore>;
export { QUOTA_LEDGER_DIR_NAME } from "./contracts";
