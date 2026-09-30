import { getChannelWorkspacePath, listChannelWorkspacePaths, setChannelWorkspacePath } from "@/lib/db";
import type { ChannelWorkspaceStore } from "../services";

export function createChannelWorkspaceStore(): ChannelWorkspaceStore {
  return {
    get: (deviceId, channelId) => getChannelWorkspacePath(deviceId, channelId),
    list: (deviceId) => listChannelWorkspacePaths(deviceId),
    set: (deviceId, channelId, path) => setChannelWorkspacePath(deviceId, channelId, path),
  };
}
