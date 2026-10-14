import {
  getStoredChannel,
  listStoredChannels,
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
  };
}
