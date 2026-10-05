import { createCloudQuotasCore } from "@/lib/cloud-quotas";
import { getQuotaReservePercent, listQuotaCalls } from "@/lib/db";
import { getQuotaLedgerSyncCore } from "@/lib/quota-ledger-sync";
import { createQuotaGuardServices } from "./services";

export function createQuotaGuardCore() {
  return createQuotaGuardServices({
    async getQuota(service) {
      const status = await createCloudQuotasCore().getQuotaStatus();
      return { connected: status.connected, status: service === "data" ? status.dataApi : status.analytics };
    },
    // The Cloud project's quota is shared by every device, and Monitoring lags a minute: count what THIS device and the devices
    // that share their log (Syncthing folder) did in the last couple of minutes, which Google's figure does not show yet.
    async sumLocalUnitsSince(service, sinceSeconds) {
      const local = (await listQuotaCalls({ sinceSeconds, service })).reduce((sum, call) => sum + (call.units ?? 0), 0);
      let peers = 0;
      try {
        peers = (await getQuotaLedgerSyncCore().readPeerCalls({ sinceSeconds, service })).reduce((sum, call) => sum + (call.units ?? 0), 0);
      } catch {
        // peers are a correction only
      }
      return local + peers;
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
