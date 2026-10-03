import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createAnalyticsStoreAdapter } from "./adapters/store";
import { createAnalyticsYoutubeApiAdapter } from "./adapters/youtube-api";
import { createDefaultLogger } from "@/lib/shared-logger";
import { createQuotaGuardCore } from "@/lib/quota-guard";
import { quotaScoped } from "@/lib/youtube-quota";
import { createAnalyticsServices } from "./services";

function defaultAuthResolver() {
  return {
    resolve: resolveGoogleCredentials,
  };
}

export function createAnalyticsCore() {
  const store = createAnalyticsStoreAdapter();
  const services = createAnalyticsServices({
    authResolver: defaultAuthResolver(),
    youtubeApi: createAnalyticsYoutubeApiAdapter(),
    videoStore: store.videoStore,
    metricStore: store.metricStore,
    channelStore: store.channelStore,
    settingsStore: store.settingsStore,
    collectionRunStore: store.collectionRunStore,
    weeklyReportStore: store.weeklyReportStore,
    clock: { now: () => new Date() },
    logger: createDefaultLogger(),
    channelAccess: createChannelAccessCore(),
  });
  // BL-117: API calls made while collecting metrics are logged against this kind of work in the quota history.
  const guard = createQuotaGuardCore();
  const context = { kind: "analytics_collection", id: null, label: "Analytics collection" };
  return {
    ...services,
    collectMetrics: quotaScoped(services.collectMetrics, context),
    // BL-117 (owner decision 2026-10-03): the AUTOMATIC collection waits while less than the configured reserve of the daily
    // quota is left, so writes keep headroom. A manual "Collect now" is the user's own call and is not held back.
    runAutoCollectionIfStale: quotaScoped(async (input: unknown) => {
      if (!(await guard.isBackgroundReadAllowed("analytics"))) return { ranCollection: false } as const;
      return services.runAutoCollectionIfStale(input);
    }, context),
  };
}

export type AnalyticsCore = ReturnType<typeof createAnalyticsCore>;
export { ANALYTICS_METRIC_NAMES, AUTO_COLLECTION_RANGE_DAYS, CHANNEL_BREAKDOWN_PRESETS, CHANNEL_OVERVIEW_METRIC_NAMES } from "./contracts";
export type { ChannelBreakdownKind, ChannelBreakdownRow, GetChannelBreakdownResult } from "./contracts";
export { CUMULATIVE_COMPARISON_METRIC_NAMES } from "./comparable-age";
export type { CumulativeComparisonMetricName } from "./comparable-age";
export { WEEKLY_REPORT_FORMAT_VERSION } from "./weekly-report";
export type { WeeklyReportContent } from "./weekly-report";
export type {
  AnalyticsMetricName,
  AutoCollectResult,
  ChannelOverviewDailyRow,
  ChannelOverviewMetricName,
  ChannelOverviewTotals,
  CollectMetricsResult,
  ComparableAgeVideoSeries,
  DataQualityReportResult,
  GetChannelOverviewResult,
  GetComparableAgeComparisonResult,
  GetWeeklyReportResult,
  ListMetricsResult,
  ListWeeklyReportsResult,
  RunWeeklyReportIfDueResult,
  StoredVideoMetricRow,
  WeeklyReportSummary,
} from "./contracts";
