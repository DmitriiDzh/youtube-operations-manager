import type {
  fetchDailyQuotaLimit,
  fetchDailyQuotaUsage,
  fetchLatestMinuteUsage,
  fetchPerMinuteQuotaLimit,
  FetchLike,
} from "./adapters/monitoring-client";
import type { CloudQuotaStatus, PerMinuteQuotaStatus, QuotaService, ServiceQuotaStatus } from "./contracts";

type ServiceDependencies = {
  cloudConnection: {
    getStatus(): Promise<{ connected: boolean }>;
    resolveCloudCredentials(): Promise<{ accessToken: string }>;
  };
  monitoringClient: {
    fetchDailyQuotaLimit: typeof fetchDailyQuotaLimit;
    fetchDailyQuotaUsage: typeof fetchDailyQuotaUsage;
    fetchPerMinuteQuotaLimit: typeof fetchPerMinuteQuotaLimit;
    fetchLatestMinuteUsage: typeof fetchLatestMinuteUsage;
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

// Cloud Monitoring API's own per-minute quota pool (`QueryRequestsPerMinutePerProject` limit
// name pairs with `quota_metric="monitoring.googleapis.com/query_requests"` -- confirmed live,
// they always co-occur on the same time series; usage has no `limit_name` label of its own, only
// `quota_metric`, so it must be looked up by that instead).
const MONITORING_QUOTA_METRIC = "monitoring.googleapis.com/query_requests";

async function fetchMonitoringOwnQuota(args: {
  accessToken: string;
  projectNumber: string;
  deps: ServiceDependencies;
}): Promise<PerMinuteQuotaStatus> {
  try {
    const [limit, usedLastMinute] = await Promise.all([
      args.deps.monitoringClient.fetchPerMinuteQuotaLimit({
        accessToken: args.accessToken,
        projectNumber: args.projectNumber,
        service: "monitoring.googleapis.com",
        fetchImpl: args.deps.fetchImpl,
      }),
      args.deps.monitoringClient.fetchLatestMinuteUsage({
        accessToken: args.accessToken,
        projectNumber: args.projectNumber,
        service: "monitoring.googleapis.com",
        quotaMetric: MONITORING_QUOTA_METRIC,
        fetchImpl: args.deps.fetchImpl,
      }),
    ]);
    if (limit === null) return null;
    return { limit, usedLastMinute };
  } catch {
    return null;
  }
}

export function createCloudQuotasServices(deps: ServiceDependencies) {
  return {
    async getQuotaStatus(): Promise<CloudQuotaStatus> {
      const connectionStatus = await deps.cloudConnection.getStatus();
      if (!connectionStatus.connected || !deps.projectNumber) {
        return { connected: connectionStatus.connected, dataApi: null, analytics: null, monitoring: null };
      }

      const { accessToken } = await deps.cloudConnection.resolveCloudCredentials();
      const projectNumber = deps.projectNumber;

      const [dataApi, analytics, monitoring] = await Promise.all([
        fetchServiceQuota({ service: "youtube.googleapis.com", accessToken, projectNumber, deps }),
        fetchServiceQuota({ service: "youtubeanalytics.googleapis.com", accessToken, projectNumber, deps }),
        fetchMonitoringOwnQuota({ accessToken, projectNumber, deps }),
      ]);

      return { connected: true, dataApi, analytics, monitoring };
    },
  };
}

export type CloudQuotasServices = ReturnType<typeof createCloudQuotasServices>;
