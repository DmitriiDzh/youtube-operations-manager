import { getStoredChannel, listStoredVideosByChannel } from "@/lib/db";

export function createLocalizationStoreAdapter() {
  return {
    getChannel: getStoredChannel,
    listVideosByChannel: listStoredVideosByChannel,
  };
}
