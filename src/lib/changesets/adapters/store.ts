import { randomUUID } from "node:crypto";
import {
  bulkUpdateStoredChanges,
  createChangeSetWithChanges,
  getStoredChangeSet,
  getStoredChannel,
  listStoredChangesByChangeSet,
  listStoredChangeSetsByChannel,
  listStoredVideosByChannel,
  updateStoredChange,
  updateStoredChangeSetStatus,
} from "@/lib/db";

export function createChangeSetChannelStoreAdapter() {
  return {
    getChannel: getStoredChannel,
    listVideosByChannel: listStoredVideosByChannel,
  };
}

export function createChangeSetStoreAdapter() {
  return {
    createChangeSetWithChanges,
    listChangeSetsByChannel: listStoredChangeSetsByChannel,
    getChangeSet: getStoredChangeSet,
    listChangesByChangeSet: listStoredChangesByChangeSet,
    updateChangeSetStatus: updateStoredChangeSetStatus,
    updateChange: updateStoredChange,
    bulkUpdateChanges: bulkUpdateStoredChanges,
  };
}

export function createIdGenerator() {
  return () => randomUUID();
}
