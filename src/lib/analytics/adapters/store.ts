import { listStoredVideosByChannel, listVideoMetricsByChannel, upsertVideoMetric } from "@/lib/db";

// Deliberately thin: only wraps the db.ts functions this module actually needs
// (upsertVideoMetric + a channel-scoped metrics read + a read of already-synced videos). Never
// wraps upsertVideos/upsertChannel/markChannelSynced or anything from youtube-write-gateway --
// this module has no legitimate reason to ever call them (docs/roadmap/plans/PHASE_8_PLAN.md §7's
// "never writes to videos/channels" acceptance criterion; see ../write-path-inventory.test.ts for
// the automated check).
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
  };
}
