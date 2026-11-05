import { getStoredChannel, listRemovedVideosByChannel, listStoredVideosByChannel } from "@/lib/db";

export function createChannelVideoStoreAdapter() {
  return {
    getChannel: getStoredChannel,
    listVideosByChannel: listStoredVideosByChannel,
    /** BL-243: the videos a sync found removed on YouTube, with when (hidden from `listVideosByChannel`). */
    listRemovedVideosByChannel,
  };
}

export type ChannelVideoStoreAdapter = ReturnType<typeof createChannelVideoStoreAdapter>;
