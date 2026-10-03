import { startOfYoutubeQuotaDay } from "@/lib/youtube-quota";
import { groupQuotaCalls, type QuotaCallLike, type QuotaHistoryEntry } from "./grouping";

export type QuotaHistoryService = "data" | "analytics";

export type QuotaHistoryEntryView = QuotaHistoryEntry & {
  /** Batch entries only: how many videos of that batch ended SUCCESS (not the call count: retries make them differ). */
  changedVideos: number | null;
};

export type QuotaHistoryResult = {
  service: QuotaHistoryService;
  windowDays: number;
  /** From Google Cloud Monitoring; all `null` when Cloud is not connected / the lookup failed (never a made-up 0). */
  cloud: { connected: boolean; limit: number | null; used: number | null; window: "since_reset" | "rolling_24h" | null; resetsAt: string | null };
  /** Units THIS device logged inside the same window as `cloud.used`. */
  localUnits: number;
  /** `cloud.used - localUnits` (never negative): another device on the shared Cloud project, or calls this log missed. `null` if unknown. */
  otherUnits: number | null;
  entries: QuotaHistoryEntryView[];
};

export type QuotaHistoryDependencies = {
  listCalls(args: { sinceSeconds: number; service: QuotaHistoryService }): Promise<Array<QuotaCallLike>>;
  countBatchRowsByStatus(batchId: string): Promise<Record<string, number>>;
  getCloudQuota(service: QuotaHistoryService): Promise<{
    connected: boolean;
    status: { limit: number; usedLast24h: number; window: "since_reset" | "rolling_24h"; resetsAt: string | null } | null;
  }>;
  clock: { now(): Date };
};

export const DEFAULT_HISTORY_DAYS = 14;
export const MAX_HISTORY_DAYS = 45;

export function createQuotaHistoryServices(deps: QuotaHistoryDependencies) {
  return {
    async getQuotaHistory(args: { service: QuotaHistoryService; days?: number }): Promise<QuotaHistoryResult> {
      const days = Math.min(Math.max(Math.floor(args.days ?? DEFAULT_HISTORY_DAYS), 1), MAX_HISTORY_DAYS);
      const now = deps.clock.now();
      const sinceSeconds = Math.floor(now.getTime() / 1000) - days * 86_400;

      const [calls, cloudQuota] = await Promise.all([
        deps.listCalls({ sinceSeconds, service: args.service }),
        deps.getCloudQuota(args.service),
      ]);

      const entries = groupQuotaCalls(calls);
      const views: QuotaHistoryEntryView[] = await Promise.all(
        entries.map(async (entry) => {
          if (entry.kind !== "batch" || !entry.contextId) return { ...entry, changedVideos: null };
          const counts = await deps.countBatchRowsByStatus(entry.contextId);
          return { ...entry, changedVideos: counts.SUCCESS ?? 0 };
        })
      );

      // The local figure must cover exactly the window Google's `used` covers, or the difference means nothing.
      const status = cloudQuota.status;
      const windowStartSeconds = !status
        ? null
        : status.window === "since_reset"
          ? Math.floor(startOfYoutubeQuotaDay(now).getTime() / 1000)
          : Math.floor(now.getTime() / 1000) - 86_400;
      const localUnits =
        windowStartSeconds === null ? 0 : calls.filter((c) => c.occurredAt >= windowStartSeconds).reduce((sum, c) => sum + (c.units ?? 0), 0);

      return {
        service: args.service,
        windowDays: days,
        cloud: {
          connected: cloudQuota.connected,
          limit: status?.limit ?? null,
          used: status?.usedLast24h ?? null,
          window: status?.window ?? null,
          resetsAt: status?.resetsAt ?? null,
        },
        localUnits,
        otherUnits: status ? Math.max(0, status.usedLast24h - localUnits) : null,
        entries: views,
      };
    },
  };
}

export type QuotaHistoryServices = ReturnType<typeof createQuotaHistoryServices>;
