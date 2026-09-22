import type { FetchLike, fetchDailyQuotaLimit, fetchDailyQuotaUsage } from "./adapters/monitoring-client";
import type { CloudQuotaStatus, QuotaService, ServiceQuotaStatus } from "./contracts";

type ServiceDependencies = {
  cloudConnection: {
    getStatus(): Promise<{ connected: boolean }>;
    resolveCloudCredentials(): Promise<{ accessToken: string }>;
  };
  monitoringClient: {
    fetchDailyQuotaLimit: typeof fetchDailyQuotaLimit;
    fetchDailyQuotaUsage: typeof fetchDailyQuotaUsage;
  };
  fetchImpl: FetchLike;
  /** `null` when `GOOGLE_CLIENT_ID` is unset/malformed -- quota status degrades to "unknown" rather than throwing. */
  projectNumber: string | null;
};

async function fetchServiceQuota(args: {
  service: QuotaService;
  accessToken: string;
  projectNumber: string;
  deps: ServiceDependencies;
}): Promise<ServiceQuotaStatus> {
  try {
    const [limit, usedLast24h] = await Promise.all([
      args.deps.monitoringClient.fetchDailyQuotaLimit({
        accessToken: args.accessToken,
        projectNumber: args.projectNumber,
        service: args.service,
        fetchImpl: args.deps.fetchImpl,
      }),
      args.deps.monitoringClient.fetchDailyQuotaUsage({
        accessToken: args.accessToken,
        projectNumber: args.projectNumber,
        service: args.service,
        fetchImpl: args.deps.fetchImpl,
      }),
    ]);
    if (limit === null) return null;
    return { limit, usedLast24h };
  } catch {
    // Never let a real Cloud Monitoring API hiccup (rate limit, transient network error, the API
    // itself disabled) crash the Settings tab -- this is informational-only, never a gate.
    return null;
  }
}

export function createCloudQuotasServices(deps: ServiceDependencies) {
  return {
    async getQuotaStatus(): Promise<CloudQuotaStatus> {
      const connectionStatus = await deps.cloudConnection.getStatus();
      if (!connectionStatus.connected || !deps.projectNumber) {
        return { connected: connectionStatus.connected, dataApi: null, analytics: null };
      }

      const { accessToken } = await deps.cloudConnection.resolveCloudCredentials();
      const projectNumber = deps.projectNumber;

      const [dataApi, analytics] = await Promise.all([
        fetchServiceQuota({ service: "youtube.googleapis.com", accessToken, projectNumber, deps }),
        fetchServiceQuota({ service: "youtubeanalytics.googleapis.com", accessToken, projectNumber, deps }),
      ]);

      return { connected: true, dataApi, analytics };
    },
  };
}

export type CloudQuotasServices = ReturnType<typeof createCloudQuotasServices>;
