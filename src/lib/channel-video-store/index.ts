import { getStoredChannel, listRemovedVideosByChannel, listStoredVideosByChannel, listVideoScanFieldsByChannel } from "@/lib/db";

export function createChannelVideoStoreAdapter() {
  return {
    getChannel: getStoredChannel,
    listVideosByChannel: listStoredVideosByChannel,
    /** BL-243: the videos a sync found removed on YouTube, with when (hidden from `listVideosByChannel`). */
    listRemovedVideosByChannel,
    /** BL-270 review: the package scan's fields of the not-removed videos, by id (the scan cache's key). */
    listVideoScanFields: listVideoScanFieldsByChannel,
  };
}

export type ChannelVideoStoreAdapter = ReturnType<typeof createChannelVideoStoreAdapter>;
