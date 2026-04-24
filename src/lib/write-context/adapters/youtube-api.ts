import { createGoogleOAuthClient } from "@/lib/auth";
import { createYoutubeClient } from "@/lib/youtube";
import type { ResolvedCredentials } from "@/lib/video-metadata/contracts";
import type { WriteChannelInfo } from "../contracts";

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
      const youtube = createAuthorizedClient(args.credentials);
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
