import { createCloudQuotasCore } from "@/lib/cloud-quotas";
import { countBatchRowsByStatus, listQuotaCalls } from "@/lib/db";
import { getQuotaLedgerSyncCore } from "@/lib/quota-ledger-sync";
import { createQuotaHistoryServices } from "./services";

export function createQuotaHistoryCore() {
  return createQuotaHistoryServices({
    listCalls: (args) => listQuotaCalls(args),
    async listPeerCalls(args) {
      try {
        return await getQuotaLedgerSyncCore().readPeerCalls(args);
      } catch {
        return []; // another device's log is an addition, never a reason to lose this device's history
      }
    },
    countBatchRowsByStatus: (batchId) => countBatchRowsByStatus(batchId),
    async getCloudQuota(service) {
      const status = await createCloudQuotasCore().getQuotaStatus();
      return { connected: status.connected, status: service === "data" ? status.dataApi : status.analytics };
    },
    clock: { now: () => new Date() },
  });
}

export type QuotaHistoryCore = ReturnType<typeof createQuotaHistoryCore>;
export type { QuotaHistoryEntryView, QuotaHistoryResult, QuotaHistoryService } from "./services";
