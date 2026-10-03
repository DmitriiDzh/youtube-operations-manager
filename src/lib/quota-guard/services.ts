import { evaluateWriteRun, backgroundReadAllowed } from "./guard";
import { MONITORING_LAG_SECONDS, type GuardVerdict, type QuotaSnapshot } from "./contracts";

export type QuotaGuardDependencies = {
  /** Data API quota status from Cloud Monitoring; `null` status = not connected / lookup failed. */
  getDataApiQuota(): Promise<{
    connected: boolean;
    status: { limit: number; usedLast24h: number; resetsAt: string | null } | null;
  }>;
  /** Units this device logged since `sinceSeconds` (unix) on the Data API. */
  sumLocalUnitsSince(sinceSeconds: number): Promise<number>;
  getReservePercent(): Promise<number>;
  clock: { now(): Date };
};

export function createQuotaGuardServices(deps: QuotaGuardDependencies) {
  async function getSnapshot(): Promise<QuotaSnapshot> {
    let quota: Awaited<ReturnType<QuotaGuardDependencies["getDataApiQuota"]>>;
    try {
      quota = await deps.getDataApiQuota();
    } catch {
      return { known: false, cloudConnected: false };
    }
    if (!quota.status) return { known: false, cloudConnected: quota.connected };

    const nowSeconds = Math.floor(deps.clock.now().getTime() / 1000);
    let recentLocalUnits = 0;
    try {
      recentLocalUnits = await deps.sumLocalUnitsSince(nowSeconds - MONITORING_LAG_SECONDS);
    } catch {
      // The local log is only a correction; Google's own figure still decides.
    }
    return { known: true, limit: quota.status.limit, used: quota.status.usedLast24h, recentLocalUnits, resetsAt: quota.status.resetsAt };
  }

  return {
    getSnapshot,
    /** The verdict for writing `videos` videos now (BL-117 slice 2). */
    async checkWriteRun(videos: number): Promise<GuardVerdict> {
      return evaluateWriteRun(videos, await getSnapshot());
    },
    /** False while less than the configured reserve of the quota is left: background reads wait so writes keep headroom. */
    async isBackgroundReadAllowed(): Promise<boolean> {
      return backgroundReadAllowed(await getSnapshot(), await deps.getReservePercent());
    },
  };
}

export type QuotaGuardServices = ReturnType<typeof createQuotaGuardServices>;
