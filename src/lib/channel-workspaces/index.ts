import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { appDataPaths } from "@/lib/db";
import { validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createChannelWorkspaceStore } from "./adapters/store";
import { createChannelWorkspacesServices } from "./services";

/**
 * Phase 11 -- see `./contracts.ts`. `getDeviceId` uses the same bootstrap config the device-
 * handoff routes use (`ensureExists` creates it with a fresh `deviceId` on first use).
 */
export function createChannelWorkspacesCore() {
  const bootstrapConfigStore = createBootstrapConfigStore(appDataPaths.bootstrapConfigPath);
  const channelConnectionsCore = createChannelConnectionsCore();
  return createChannelWorkspacesServices({
    getDeviceId: async () => (await bootstrapConfigStore.ensureExists()).deviceId,
    store: createChannelWorkspaceStore(),
    listConnectedChannelIds: async () =>
      (await channelConnectionsCore.listConnectedChannels()).map((channel) => channel.channelId),
    validatePath: validateOperatorDirectoryPath,
  });
}

export type ChannelWorkspacesCore = ReturnType<typeof createChannelWorkspacesCore>;
export type { ChannelWorkspaceListEntry, ChannelWorkspaceResult } from "./contracts";
export { getChannelWorkspaceInputSchema, getChannelWorkspaceOutputSchema, setChannelWorkspaceInputSchema } from "./schemas";
export { isDomainError } from "./contracts";
