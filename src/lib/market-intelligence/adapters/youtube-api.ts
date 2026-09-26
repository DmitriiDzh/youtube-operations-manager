import { createGoogleOAuthClient } from "@/lib/auth";
import { createYoutubeClient, getPublicChannelSnapshot } from "@/lib/youtube-read-gateway";
import type { ResolvedCredentials } from "../contracts";

function createAuthorizedClient(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
  });

  return createYoutubeClient(oauth2);
}

// Phase 9 slice 3 -- same shape as channel-sync's own adapters/youtube-api.ts, reading through
// the shared read gateway (never a second googleapis import, AGENTS.md §G/§M).
export function createMarketIntelligenceYoutubeApiAdapter() {
  return {
    async getPublicChannelSnapshot(args: { credentials: ResolvedCredentials; channelId: string }) {
      const youtube = await createAuthorizedClient(args.credentials);
      return getPublicChannelSnapshot(youtube, args.channelId);
    },
  };
}
