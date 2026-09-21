import { randomUUID } from "node:crypto";
import { getStoredChannel, listStoredVideosByChannel } from "@/lib/db";

export function createChangeSetChannelStoreAdapter() {
  return {
    getChannel: getStoredChannel,
    listVideosByChannel: listStoredVideosByChannel,
  };
}

export function createIdGenerator() {
  return () => randomUUID();
}
