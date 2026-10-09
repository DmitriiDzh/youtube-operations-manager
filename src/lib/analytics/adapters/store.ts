import {
  getAnalyticsSyncSettings,
  getStoredChannel,
  getWeeklyReportByWeek,
  advanceVideoHistory,
  listAnalyticsCollectionRunsByChannel,
  getLatestChannelMetricCollectedAt,
  listChannelMetricsInRange,
  listVideoHistoryByChannel,
  listStoredVideosByChannel,
  listVideoMetricsByChannel,
  listWeeklyReportsByChannel,
  markAnalyticsAutoCollected,
  recordAnalyticsCollectionRun,
  saveChannelDailyMetric,
  upsertVideoMetric,
  upsertWeeklyReport,
  listVideoMilestones,
  recordVideoMilestoneFailure,
  saveCollectedVideoMilestone,
} from "@/lib/db";

// Deliberately thin: only wraps the db.ts functions this module actually needs
// (upsertVideoMetric + a channel-scoped metrics read + a read of already-synced videos +
// the BL-059 auto-collection timestamp/settings). Never wraps upsertVideos/upsertChannel/
// markChannelSynced or anything from youtube-write-gateway -- this module has no legitimate
// reason to ever call them (docs/roadmap/plans/PHASE_8_PLAN.md §7's "never writes to
// videos/channels" acceptance criterion; see ../write-path-inventory.test.ts for the automated
// check). `markAnalyticsAutoCollected` is the one legitimate exception -- it writes a single
// `channels` column dedicated to this module's own concern, never any other field on that row.
/** BL-166: the milestone service's store (`milestones.ts`): video lengths and publish dates, and the milestone rows. */
export function createVideoMilestoneStoreAdapter() {
  return {
    videoStore: {
      async listVideos(channelId: string) {
        return (await listStoredVideosByChannel(channelId)).map((record) => ({
          videoId: record.videoId,
          publishedAt: record.publishedAt ?? null,
          durationSeconds: record.durationSeconds ?? null,
        }));
      },
    },
    store: {
      list: (channelId: string, filter?: { videoIds?: string[]; milestoneDays?: number }) => listVideoMilestones(channelId, filter),
      saveCollected: (row: Parameters<typeof saveCollectedVideoMilestone>[0]) => saveCollectedVideoMilestone(row),
      recordFailure: (row: Parameters<typeof recordVideoMilestoneFailure>[0]) => recordVideoMilestoneFailure(row),
    },
  };
}

export function createAnalyticsStoreAdapter() {
  return {
    videoStore: {
      async listVideosByChannel(channelId: string) {
        const records = await listStoredVideosByChannel(channelId);
        return records.map((record) => ({ videoId: record.videoId, channelId: record.channelId }));
      },
      // Phase 8 follow-up, slice 3 (comparable-age comparison) -- needs each video's own
      // publishedAt/title, unlike listVideosByChannel's bare id pair above. Reuses the same
      // already-synced-videos read, never a parallel query.
      async listVideoDetailsByChannel(channelId: string) {
        const records = await listStoredVideosByChannel(channelId);
        return records.map((record) => ({
          videoId: record.videoId,
          title: record.title,
          publishedAt: record.publishedAt,
        }));
      },
    },
    metricStore: {
      upsertMetric: upsertVideoMetric,
      listMetricsByChannel: listVideoMetricsByChannel,
    },
    // BL-118: channel-level daily totals stored locally.
    channelMetricStore: {
      upsert: saveChannelDailyMetric,
      listInRange: listChannelMetricsInRange,
      getLatestCollectedAt: getLatestChannelMetricCollectedAt,
    },
    // BL-118: per-video history coverage.
    historyStore: {
      listByChannel: listVideoHistoryByChannel,
      advance: advanceVideoHistory,
    },
    channelStore: {
      async getAnalyticsLastAutoCollectedAt(channelId: string) {
        const channel = await getStoredChannel(channelId);
        return channel?.analyticsLastAutoCollectedAt ?? null;
      },
      markAnalyticsAutoCollected,
      async getChannelPublishedAt(channelId: string) {
        return (await getStoredChannel(channelId))?.publishedAt ?? null;
      },
    },
    settingsStore: {
      getAnalyticsSyncSettings,
    },
    // Phase 8 follow-up, slice 2 (data-quality diagnostics) -- append-only history of each
    // collectMetrics run, the ground truth `getDataQualityReport` reads (video_metrics_daily
    // alone can't distinguish "never collected" from "collected, zero activity", since the
    // Analytics API silently omits zero-activity days from its own response).
    collectionRunStore: {
      record: recordAnalyticsCollectionRun,
      listByChannel: listAnalyticsCollectionRunsByChannel,
    },
    // Phase 8 follow-up, slice 4 (weekly reports) -- read/write of the frozen snapshot table.
    weeklyReportStore: {
      getByWeek: getWeeklyReportByWeek,
      upsert: upsertWeeklyReport,
      listByChannel: listWeeklyReportsByChannel,
    },
  };
}
