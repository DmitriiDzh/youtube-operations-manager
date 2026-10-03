import { createCloudQuotasCore } from "@/lib/cloud-quotas";
import { getQuotaReservePercent, listQuotaCalls } from "@/lib/db";
import { createQuotaGuardServices } from "./services";

export function createQuotaGuardCore() {
  return createQuotaGuardServices({
    async getDataApiQuota() {
      const status = await createCloudQuotasCore().getQuotaStatus();
      return { connected: status.connected, status: status.dataApi };
    },
    async sumLocalUnitsSince(sinceSeconds) {
      const calls = await listQuotaCalls({ sinceSeconds, service: "data" });
      return calls.reduce((sum, call) => sum + (call.units ?? 0), 0);
    },
    getReservePercent: () => getQuotaReservePercent(),
    clock: { now: () => new Date() },
  });
}

export type QuotaGuardCore = ReturnType<typeof createQuotaGuardCore>;
export {
  DEFAULT_QUOTA_RESERVE_PERCENT,
  MAX_QUOTA_RESERVE_PERCENT,
  MIN_QUOTA_RESERVE_PERCENT,
  QUOTA_SAFETY_MARGIN_UNITS,
  UNITS_PER_WRITTEN_VIDEO,
} from "./contracts";
export type { GuardVerdict, QuotaSnapshot } from "./contracts";
export { evaluateWriteRun, videosThatFit } from "./guard";
