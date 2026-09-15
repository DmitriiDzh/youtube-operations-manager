import { createGoogleOAuthClient } from "@/lib/auth";
import {
  createYoutubeClient,
  getChannelForSync,
  getVideosMetadataContextBatch,
  listUploadsPlaylistVideoIds,
} from "@/lib/youtube";
import type { ResolvedCredentials } from "../contracts";

function createAuthorizedClient(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
  });

  return createYoutubeClient(oauth2);
}

export function createChannelSyncYoutubeApiAdapter() {
  return {
    async getChannelForSync(args: { credentials: ResolvedCredentials; channelId?: string }) {
      const youtube = createAuthorizedClient(args.credentials);
      return getChannelForSync(youtube, args.channelId);
    },

    async listUploadsPlaylistVideoIds(args: {
      credentials: ResolvedCredentials;
      uploadsPlaylistId: string;
    }) {
      const youtube = createAuthorizedClient(args.credentials);
      return listUploadsPlaylistVideoIds(youtube, args.uploadsPlaylistId);
    },

    async getVideosMetadataBatch(args: {
      credentials: ResolvedCredentials;
      videoIds: string[];
    }) {
      const youtube = createAuthorizedClient(args.credentials);
      return getVideosMetadataContextBatch(youtube, args.videoIds);
    },
  };
}
