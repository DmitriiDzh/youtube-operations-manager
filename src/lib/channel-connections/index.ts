import { revokeGoogleToken } from "@/lib/auth";
import {
  clearUserOAuthTokens,
  getStoredChannel,
  getUserOAuthTokens,
  getUserProfileForActivation,
  listStoredChannels,
  setChannelConnectedUserId,
} from "@/lib/db";
import { createChannelConnectionsServices } from "./services";

export function createChannelConnectionsCore() {
  return createChannelConnectionsServices({
    store: {
      async listChannels() {
        const channels = await listStoredChannels();
        return channels.map((c) => ({
          channelId: c.channelId,
          title: c.title,
          thumbnailUrl: c.thumbnailUrl,
          connectedUserId: c.connectedUserId,
          connectedAt: c.connectedAt,
        }));
      },
      async getChannel(channelId) {
        const channel = await getStoredChannel(channelId);
        if (!channel) return null;
        return {
          channelId: channel.channelId,
          title: channel.title,
          thumbnailUrl: channel.thumbnailUrl,
          connectedUserId: channel.connectedUserId,
          connectedAt: channel.connectedAt,
        };
      },
      getUserProfile: getUserProfileForActivation,
      async getUserTokens(userId) {
        const tokens = await getUserOAuthTokens(userId);
        if (!tokens) return null;
        return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
      },
      clearUserTokens: clearUserOAuthTokens,
      setChannelConnectedUserId,
    },
    revokeToken: revokeGoogleToken,
  });
}

export type ChannelConnectionsCore = ReturnType<typeof createChannelConnectionsCore>;

export * from "./contracts";
