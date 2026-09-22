import { createGoogleOAuthClient } from "@/lib/auth";
import { createYoutubeClient } from "@/lib/youtube-read-gateway";
import type { ResolvedCredentials } from "@/lib/video-metadata/contracts";
import type { WriteChannelInfo } from "../contracts";

// This adapter resolves the active-channel identity `write-context.assertWriteChannel` uses as
// the guardrail immediately before every WRITE across the app (AGENTS.md §G) -- it is gated by
// `createYoutubeClient`'s own `assertDataApiReadsAuthorized` check like every other Data API v3
// caller, so disabling "Data API reads" also correctly fails a write's identity check (see that
// function's doc comment for why this coupling is intentional, not incidental).
function createAuthorizedClient(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
  });

  return createYoutubeClient(oauth2);
}

export function createWriteContextYoutubeApiAdapter() {
  return {
    async getActiveChannel(args: {
      credentials: ResolvedCredentials;
    }): Promise<WriteChannelInfo | null> {
      const youtube = await createAuthorizedClient(args.credentials);
      const response = await youtube.channels.list({
        part: ["id", "snippet"],
        mine: true,
        maxResults: 1,
      });

      const channel = response.data.items?.[0];
      if (!channel?.id) {
        return null;
      }

      return {
        id: channel.id,
        title: channel.snippet?.title ?? null,
      };
    },
  };
}
