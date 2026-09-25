import { getStoredChannel, listStoredVideosByChannel } from "@/lib/db";
import { createIdGenerator } from "../contracts";

export function createChangeSetChannelStoreAdapter() {
  return {
    getChannel: getStoredChannel,
    listVideosByChannel: listStoredVideosByChannel,
  };
}

export { createIdGenerator };
