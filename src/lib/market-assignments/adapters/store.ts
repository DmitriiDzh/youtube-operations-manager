import {
  addChannelRecordAssignment,
  listChannelAssignedRecordIds,
  listRecordAssignmentsByKind,
  setRecordAssignmentChannels,
} from "@/lib/db";
import type { MarketAssignmentStore } from "../services";

export function createMarketAssignmentStore(): MarketAssignmentStore {
  return {
    listAssignedRecordIds: (channelId, recordKind) => listChannelAssignedRecordIds(channelId, recordKind),
    listByKind: (recordKind) => listRecordAssignmentsByKind(recordKind),
    setChannels: (recordKind, recordId, channelIds) => setRecordAssignmentChannels(recordKind, recordId, channelIds),
    add: (channelId, recordKind, recordId) => addChannelRecordAssignment(channelId, recordKind, recordId),
  };
}
