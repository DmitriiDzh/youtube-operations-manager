import {
  getStoredChannel,
  listStoredChannels,
  listStoredVideosByIds,
  listStoredVideosByChannel,
  markChannelSynced,
  markVideosRemovedOnYoutube,
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
    markVideosRemovedOnYoutube,
    listVideosByIds: listStoredVideosByIds,
  };
}
