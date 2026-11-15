import { probeGoogleRefreshToken, revokeGoogleToken } from "@/lib/auth";
import {
  clearUserOAuthTokens,
  getRefreshTokenIssuedAt,
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
      getRefreshTokenIssuedAt,
    },
    revokeToken: revokeGoogleToken,
    probeRefreshToken: probeGoogleRefreshToken,
    clock: { now: () => new Date() },
  });
}

export type ChannelConnectionsCore = ReturnType<typeof createChannelConnectionsCore>;

/**
 * The Google account a channel is connected under here -- only for a channel Settings → Channels lists as connected, else null.
 * The one definition for agent paths that act for a channel (the Producer session, BL-255's thumbnail writer).
 */
export async function resolveConnectedChannelUser(channelId: string): Promise<string | null> {
  const connected = (await createChannelConnectionsCore().listConnectedChannels()).some((channel) => channel.channelId === channelId);
  return connected ? ((await getStoredChannel(channelId))?.connectedUserId ?? null) : null;
}

export * from "./contracts";
export { classifyConnectionHealth } from "./connection-health";
