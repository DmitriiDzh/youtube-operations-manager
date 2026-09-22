import { createGoogleOAuthClient } from "@/lib/auth";
import {
  createYoutubeClient,
  getMyChannelId,
  getVideoById,
  getVideoMetadataContext,
  listVideosByChannel,
} from "@/lib/youtube-read-gateway";
import { applyVideoMetadataUpdate, assertLiveWritesAuthorized } from "@/lib/youtube-write-gateway";
import {
  DomainError,
  isDomainError,
  type MetadataSyncProposal,
  type ResolvedCredentials,
  type VideoMetadataContext,
} from "../contracts";

function createAuthorizedClient(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
  });

  return createYoutubeClient(oauth2);
}

export function createYoutubeApiAdapter() {
  return {
    async listVideos(args: {
      credentials: ResolvedCredentials;
      channelId?: string;
      maxResults?: number;
    }) {
      const youtube = createAuthorizedClient(args.credentials);
      const channelId = args.channelId ?? (await getMyChannelId(youtube));

      if (!channelId) {
        throw new DomainError({
          code: "unauthorized",
          message: "Cannot resolve channel for the current credentials",
        });
      }

      return listVideosByChannel({ youtube, channelId, maxResults: args.maxResults });
    },

    async getVideo(args: { credentials: ResolvedCredentials; videoId: string }) {
      const youtube = createAuthorizedClient(args.credentials);
      const video = await getVideoById(youtube, args.videoId);

      if (!video) {
        throw new DomainError({
          code: "not_found",
          message: "Video not found",
          details: { videoId: args.videoId },
        });
      }

      return video;
    },

    async getVideoMetadataContext(args: { credentials: ResolvedCredentials; videoId: string }) {
      const youtube = createAuthorizedClient(args.credentials);
      const context = await getVideoMetadataContext(youtube, args.videoId);

      if (!context) {
        throw new DomainError({
          code: "not_found",
          message: "Video metadata context not found",
          details: { videoId: args.videoId },
        });
      }

      return JSON.parse(JSON.stringify(context)) as VideoMetadataContext;
    },

    async applyMetadataProposal(args: {
      credentials: ResolvedCredentials;
      proposal: MetadataSyncProposal;
    }) {
      const targetLocalization = args.proposal.update.localizations[args.proposal.targetLanguage];

      if (!targetLocalization) {
        throw new DomainError({
          code: "validation_failed",
          message: "Proposal missing target localization payload",
          details: {
            targetLanguage: args.proposal.targetLanguage,
          },
        });
      }

      await assertLiveWritesAuthorized();
      const youtube = createAuthorizedClient(args.credentials);

      try {
        await applyVideoMetadataUpdate({
          youtube,
          update: args.proposal.update,
        });
      } catch (error) {
        if (isDomainError(error)) throw error;
        throw new DomainError({
          code: "update_failed",
          message: "Failed to update YouTube metadata",
          details: {
            videoId: args.proposal.update.videoId,
            cause: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },
  };
}
