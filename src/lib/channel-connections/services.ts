import type { revokeGoogleToken } from "@/lib/auth";
import { classifyConnectionHealth } from "./connection-health";
import {
  DomainError,
  HEALTH_PROBE_CACHE_MINUTES,
  type ActivationIdentity,
  type ConnectedChannel,
  type ConnectionHealth,
  type DisconnectResult,
  type HealthProbe,
} from "./contracts";

type StoredChannelLike = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  connectedUserId: string | null;
  connectedAt: Date;
};

type UserProfileLike = {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  hasAccessToken: boolean;
};

type StoredOAuthTokenLike = {
  accessToken: string | null;
  refreshToken: string | null;
};

type ServiceDependencies = {
  store: {
    listChannels(): Promise<StoredChannelLike[]>;
    getChannel(channelId: string): Promise<StoredChannelLike | null>;
    getUserProfile(userId: string): Promise<UserProfileLike | null>;
    getUserTokens(userId: string): Promise<StoredOAuthTokenLike | null>;
    clearUserTokens(userId: string): Promise<void>;
    setChannelConnectedUserId(channelId: string, connectedUserId: string | null): Promise<void>;
    /** When Google issued this identity's refresh token (BL-115); `null` = never recorded. */
    getRefreshTokenIssuedAt(userId: string): Promise<Date | null>;
  };
  revokeToken: typeof revokeGoogleToken;
  /** Asks Google whether a refresh token still works (BL-115); never throws, never logs the token. */
  probeRefreshToken(refreshToken: string): Promise<"ok" | "invalid_grant" | "error">;
  clock: { now(): Date };
};

export function createChannelConnectionsServices(deps: ServiceDependencies) {
  // Real-check results by internal user id. `error` outcomes are never cached (retry next time).
  const probeCache = new Map<string, { probe: "ok" | "invalid_grant"; at: Date }>();

  return {
    /** Every locally-known channel that currently has a connected identity, for the Settings
     * "Channels" list. Never includes a channel whose OAuth link has been disconnected.
     * `activeUserId` (the live session's `users.id`, or undefined for no session) decides
     * `isActive` per row -- compared against the internal `connectedUserId`, never the public
     * `connectedEmail` (two channels can share one Google account's email). */
    async listConnectedChannels(activeUserId?: string): Promise<ConnectedChannel[]> {
      const allChannels = await deps.store.listChannels();
      const connected = allChannels.filter(
        (c): c is StoredChannelLike & { connectedUserId: string } => c.connectedUserId !== null
      );

      const resolved = await Promise.all(
        connected.map(async (c) => {
          const profile = await deps.store.getUserProfile(c.connectedUserId);
          // A `connectedUserId` pointing at a `users` row that no longer exists shouldn't happen
          // in practice (disconnect only ever clears tokens, never deletes the row), but fail
          // closed by omitting the row rather than showing a broken entry with no email.
          if (!profile) return null;

          return {
            channelId: c.channelId,
            title: c.title,
            thumbnailUrl: c.thumbnailUrl,
            connectedEmail: profile.email,
            connectedAt: c.connectedAt.toISOString(),
            isActive: c.connectedUserId === activeUserId,
          } satisfies ConnectedChannel;
        })
      );

      return resolved.filter((c): c is ConnectedChannel => c !== null);
    },

    /**
     * BL-115 -- the health of every connected channel's stored Google grant, for the dashboard's re-login prompt
     * and the Settings badges. One real refresh-token check per connection, reused for
     * `HEALTH_PROBE_CACHE_MINUTES` unless `forceRefresh`. A connection with no stored refresh token cannot renew
     * its access, so it counts as `invalid_grant`. Never returns or logs a token or the internal user id.
     */
    async getConnectionHealth(activeUserId?: string, options: { forceRefresh?: boolean } = {}): Promise<ConnectionHealth[]> {
      const now = deps.clock.now();
      const connected = (await deps.store.listChannels()).filter(
        (c): c is StoredChannelLike & { connectedUserId: string } => c.connectedUserId !== null
      );

      const results = await Promise.all(
        connected.map(async (c): Promise<ConnectionHealth | null> => {
          const profile = await deps.store.getUserProfile(c.connectedUserId);
          if (!profile) return null;

          const [tokens, issuedAt] = await Promise.all([
            deps.store.getUserTokens(c.connectedUserId),
            deps.store.getRefreshTokenIssuedAt(c.connectedUserId),
          ]);

          let probe: HealthProbe;
          let checkedAt: Date | null = null;
          if (!tokens?.refreshToken) {
            probe = "invalid_grant";
          } else {
            const cached = probeCache.get(c.connectedUserId);
            const fresh = cached && now.getTime() - cached.at.getTime() < HEALTH_PROBE_CACHE_MINUTES * 60_000;
            if (cached && fresh && !options.forceRefresh) {
              probe = cached.probe;
              checkedAt = cached.at;
            } else {
              const result = await deps.probeRefreshToken(tokens.refreshToken);
              probe = result;
              if (result === "error") {
                probeCache.delete(c.connectedUserId);
              } else {
                checkedAt = now;
                probeCache.set(c.connectedUserId, { probe: result, at: now });
              }
            }
          }

          const verdict = classifyConnectionHealth({ refreshTokenIssuedAt: issuedAt, probe, now });
          return {
            channelId: c.channelId,
            title: c.title,
            connectedEmail: profile.email,
            isActive: c.connectedUserId === activeUserId,
            state: verdict.state,
            ageDays: verdict.ageDays,
            daysLeft: verdict.daysLeft,
            checkedAt: checkedAt ? checkedAt.toISOString() : null,
          };
        })
      );
      return results.filter((r): r is ConnectionHealth => r !== null);
    },

    /** Resolves the identity to hand to NextAuth's Credentials provider so it can mint a session
     * for an already-connected channel, without any Google round-trip. Fails closed for a channel
     * that is unknown, not connected, or whose stored connection has no usable access token. */
    async resolveChannelIdentityForActivation(channelId: string): Promise<ActivationIdentity> {
      const channel = await deps.store.getChannel(channelId);
      if (!channel?.connectedUserId) {
        throw new DomainError({
          code: "channel_not_connected",
          message: `Channel ${channelId} is not connected -- nothing to activate.`,
        });
      }

      const profile = await deps.store.getUserProfile(channel.connectedUserId);
      if (!profile || !profile.hasAccessToken) {
        throw new DomainError({
          code: "channel_not_connected",
          message: `Channel ${channelId}'s stored connection no longer has a usable access token. Reconnect it via "Connect a new channel."`,
        });
      }

      return {
        userId: profile.userId,
        email: profile.email,
        name: profile.name,
        image: profile.image,
      };
    },

    /** Revokes the channel's stored token with Google (best-effort -- a failed revoke, e.g. the
     * token was already invalid, must never block clearing the local credential: the caller needs
     * `disconnectedUserId` reliably to decide whether to force a client-side sign-out, and a
     * connection should never keep looking "active" merely because Google's own revoke call
     * happened to fail), clears the stored tokens, and unlinks the channel. A safe no-op if the
     * channel was already disconnected. */
    async disconnectChannel(channelId: string): Promise<DisconnectResult> {
      const channel = await deps.store.getChannel(channelId);
      if (!channel?.connectedUserId) {
        return { disconnected: false, disconnectedUserId: null };
      }

      const userId = channel.connectedUserId;
      const tokens = await deps.store.getUserTokens(userId);
      const revocationToken = tokens?.refreshToken ?? tokens?.accessToken ?? null;

      try {
        if (revocationToken) {
          await deps.revokeToken(revocationToken);
        }
      } catch {
        // Best-effort -- see doc comment above.
      } finally {
        await deps.store.clearUserTokens(userId);
        await deps.store.setChannelConnectedUserId(channelId, null);
      }

      return { disconnected: true, disconnectedUserId: userId };
    },
  };
}

export type ChannelConnectionsServices = ReturnType<typeof createChannelConnectionsServices>;
