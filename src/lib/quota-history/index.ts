import { createCloudQuotasCore } from "@/lib/cloud-quotas";
import { countBatchRowsByStatus, listQuotaCalls } from "@/lib/db";
import { createQuotaHistoryServices } from "./services";

export function createQuotaHistoryCore() {
  return createQuotaHistoryServices({
    listCalls: (args) => listQuotaCalls(args),
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
