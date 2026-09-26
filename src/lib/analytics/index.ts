import { resolveGoogleCredentials } from "@/lib/video-metadata/adapters/google-auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createAnalyticsStoreAdapter } from "./adapters/store";
import { createAnalyticsYoutubeApiAdapter } from "./adapters/youtube-api";
import { createDefaultLogger } from "./adapters/logger";
import { createAnalyticsServices } from "./services";

function defaultAuthResolver() {
  return {
    resolve: resolveGoogleCredentials,
  };
}

export function createAnalyticsCore() {
  const store = createAnalyticsStoreAdapter();
  return createAnalyticsServices({
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
