import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createAnalyticsStoreAdapter, createVideoMilestoneStoreAdapter } from "./adapters/store";
import { createVideoMilestoneServices } from "./milestones";
import { createAnalyticsYoutubeApiAdapter } from "./adapters/youtube-api";
import { createDefaultLogger } from "@/lib/shared-logger";
import { createQuotaGuardCore } from "@/lib/quota-guard";
import { quotaScoped } from "@/lib/youtube-quota";
import { createAnalyticsServices } from "./services";
import { runAutoCollectionForChannels } from "./auto-collect-all";
import { createBackgroundFailureBackoff, listChannelConnections } from "@/lib/channel-fanout";

function defaultAuthResolver() {
  return {
    resolve: resolveGoogleCredentials,
  };
}

// BL-142: one in-process backoff for failing background channels, shared by every core instance and every module copy
// Next loads (kept on globalThis, like the operation registry).
const backgroundBackoff: ReturnType<typeof createBackgroundFailureBackoff> = ((globalThis as unknown as Record<symbol, ReturnType<typeof createBackgroundFailureBackoff> | undefined>)[
  Symbol.for("youtube-operations-manager.analytics-background-backoff")
] ??= createBackgroundFailureBackoff());
const backgroundLogger = createDefaultLogger();

export function createAnalyticsCore() {
  const store = createAnalyticsStoreAdapter();
  const services = createAnalyticsServices({
    authResolver: defaultAuthResolver(),
    youtubeApi: createAnalyticsYoutubeApiAdapter(),
    videoStore: store.videoStore,
    metricStore: store.metricStore,
    channelMetricStore: {
      upsert: store.channelMetricStore.upsert,
      listInRange: store.channelMetricStore.listInRange,
      getLatestCollectedAt: store.channelMetricStore.getLatestCollectedAt,
    },
    historyStore: store.historyStore,
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
  const core = {
    ...services,
    collectMetrics: quotaScoped(services.collectMetrics, context),
    // BL-117 (owner decision 2026-10-03): the AUTOMATIC collection waits while less than the configured reserve of the daily
    // quota is left, so writes keep headroom. A manual "Collect now" is the user's own call and is not held back.
    // BL-118: the automatic history catch-up is a background read too (same reserve, same work context).
    runHistoryCatchUp: quotaScoped(async (input: unknown, options?: Parameters<typeof services.runHistoryCatchUp>[1]) => {
      if (!(await guard.isBackgroundReadAllowed("analytics"))) return { ranCatchUp: false } as const;
      return services.runHistoryCatchUp(input, options);
    }, context),
    runAutoCollectionIfStale: quotaScoped(async (input: unknown) => {
      if (!(await guard.isBackgroundReadAllowed("analytics"))) return { ranCollection: false } as const;
      return services.runAutoCollectionIfStale(input);
    }, context),
  };
  // BL-166 (docs/roadmap/plans/VIDEO_MILESTONES_PLAN.md): day-7 / day-28 milestones, a background read like the catch-up -- same
  // reads switch (inside the client), same quota reserve, same quota-history label.
  const milestoneStore = createVideoMilestoneStoreAdapter();
  const milestones = createVideoMilestoneServices({
    clock: { now: () => new Date() },
    authResolver: defaultAuthResolver(),
    channelAccess: createChannelAccessCore(),
    videoStore: milestoneStore.videoStore,
    youtubeApi: createAnalyticsYoutubeApiAdapter(),
    store: milestoneStore.store,
  });
  return {
    ...core,
    collectDueMilestones: quotaScoped(async (input: unknown) => {
      if (!(await guard.isBackgroundReadAllowed("analytics"))) return { attempted: 0, collected: 0, failed: 0 };
      return milestones.collectDueMilestones(input);
    }, context),
    listVideoMilestones: milestones.listVideoMilestones,
    // BL-142: the dashboard's automatic collection for every connected channel (auto-collect-all.ts). It is handed the
    // quota-guarded functions above, never the raw services, so background channels keep the same reserve and quota
    // attribution.
    runAutoCollectionForChannels: (input: { sessionUserId: string; activeChannelId: string | null; which: "active" | "background" }) =>
      runAutoCollectionForChannels(
        {
          listChannelConnections,
          runAutoCollectionIfStale: core.runAutoCollectionIfStale,
          runWeeklyReportIfDue: core.runWeeklyReportIfDue,
          getHistoryCatchUpPlan: core.getHistoryCatchUpPlan,
          backoff: backgroundBackoff,
          onBackgroundIssue: (channelId, message) => backgroundLogger.info({ event: "analytics.auto_collect_all.background", context: { channelId, message } }),
        },
        input
      ),
  };
}

export type AnalyticsCore = ReturnType<typeof createAnalyticsCore>;
export type { AutoCollectAllResult, AutoCollectChannelOutcome } from "./auto-collect-all";
export { beginAllChannelsRun, endAllChannelsRun } from "./auto-collect-all";
export { ANALYTICS_METRIC_NAMES, AUTO_COLLECTION_RANGE_DAYS, CHANNEL_BREAKDOWN_PRESETS, CHANNEL_OVERVIEW_METRIC_NAMES } from "./contracts";
export type { ChannelBreakdownKind, ChannelBreakdownRow, GetChannelBreakdownResult } from "./contracts";
export { buildChannelOverviewView } from "./overview-view";
export type { ChannelOverviewView } from "./overview-view";
export type { Granularity } from "./granularity";
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
