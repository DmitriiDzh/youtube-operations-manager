import {
  getStoredChannel,
  listStoredChannels,
  listStoredVideosByChannel,
  markChannelSynced,
  upsertChannel,
  upsertVideos,
} from "@/lib/db";

export function createChannelSyncStoreAdapter() {
  return {
    upsertChannel,
    markChannelSynced,
    listChannels: listStoredChannels,
    getChannel: getStoredChannel,
    upsertVideos,
    listVideosByChannel: listStoredVideosByChannel,
  };
}
