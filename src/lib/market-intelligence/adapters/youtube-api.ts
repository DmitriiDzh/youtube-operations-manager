import { createGoogleOAuthClient } from "@/lib/auth";
import {
  createYoutubeClient,
  getPublicChannelSnapshot,
  getPublicVideoSnapshots,
  listUploadsPlaylistFirstPageVideoIds,
  searchPublicChannels,
} from "@/lib/youtube-read-gateway";
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
    // Phase 9 slice 9B (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md).
    async listUploadsPlaylistFirstPageVideoIds(args: { credentials: ResolvedCredentials; uploadsPlaylistId: string }) {
      const youtube = await createAuthorizedClient(args.credentials);
      return listUploadsPlaylistFirstPageVideoIds(youtube, args.uploadsPlaylistId);
    },
    async getPublicVideoSnapshots(args: { credentials: ResolvedCredentials; videoIds: string[] }) {
      const youtube = await createAuthorizedClient(args.credentials);
      return getPublicVideoSnapshots(youtube, args.videoIds);
    },
    // Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md).
    async searchPublicChannels(args: { credentials: ResolvedCredentials; query: string }) {
      const youtube = await createAuthorizedClient(args.credentials);
      return searchPublicChannels(youtube, args.query);
    },
  };
}
