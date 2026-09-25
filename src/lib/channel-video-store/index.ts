import { getStoredChannel, listStoredVideosByChannel } from "@/lib/db";

export function createChannelVideoStoreAdapter() {
  return {
    getChannel: getStoredChannel,
    listVideosByChannel: listStoredVideosByChannel,
  };
}

export type ChannelVideoStoreAdapter = ReturnType<typeof createChannelVideoStoreAdapter>;
