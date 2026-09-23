import {
  getAnalyticsSyncSettings,
  getStoredChannel,
  listAnalyticsCollectionRunsByChannel,
  listStoredVideosByChannel,
  listVideoMetricsByChannel,
  markAnalyticsAutoCollected,
  recordAnalyticsCollectionRun,
  upsertVideoMetric,
} from "@/lib/db";

// Deliberately thin: only wraps the db.ts functions this module actually needs
// (upsertVideoMetric + a channel-scoped metrics read + a read of already-synced videos +
// the BL-059 auto-collection timestamp/settings). Never wraps upsertVideos/upsertChannel/
// markChannelSynced or anything from youtube-write-gateway -- this module has no legitimate
// reason to ever call them (docs/roadmap/plans/PHASE_8_PLAN.md §7's "never writes to
// videos/channels" acceptance criterion; see ../write-path-inventory.test.ts for the automated
// check). `markAnalyticsAutoCollected` is the one legitimate exception -- it writes a single
// `channels` column dedicated to this module's own concern, never any other field on that row.
export function createAnalyticsStoreAdapter() {
  return {
    videoStore: {
      async listVideosByChannel(channelId: string) {
        const records = await listStoredVideosByChannel(channelId);
        return records.map((record) => ({ videoId: record.videoId, channelId: record.channelId }));
      },
    },
    metricStore: {
      upsertMetric: upsertVideoMetric,
      listMetricsByChannel: listVideoMetricsByChannel,
    },
    channelStore: {
      async getAnalyticsLastAutoCollectedAt(channelId: string) {
        const channel = await getStoredChannel(channelId);
        return channel?.analyticsLastAutoCollectedAt ?? null;
      },
      markAnalyticsAutoCollected,
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
  };
}
