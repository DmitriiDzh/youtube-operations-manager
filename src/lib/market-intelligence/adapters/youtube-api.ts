import { createGoogleOAuthClient } from "@/lib/auth";
import {
  assertDataApiReadsAuthorized,
  createYoutubeClient,
  getPublicChannelSnapshot,
  getPublicVideoSnapshots,
  getPublicVideoStatsBatch,
  getMostPopularMusicVideos,
  listChannelFeedVideos,
  listUploadsPlaylistPage,
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
    async listUploadsPlaylistPage(args: { credentials: ResolvedCredentials; uploadsPlaylistId: string; pageToken?: string }) {
      const youtube = await createAuthorizedClient(args.credentials);
      return listUploadsPlaylistPage(youtube, args.uploadsPlaylistId, args.pageToken);
    },
    async getPublicVideoSnapshots(args: { credentials: ResolvedCredentials; videoIds: string[] }) {
      const youtube = await createAuthorizedClient(args.credentials);
      return getPublicVideoSnapshots(youtube, args.videoIds);
    },
    // Phase 13 slices 13.5/13.6.
    async listChannelFeedVideoIds(args: { channelId: string }) {
      return listChannelFeedVideos(args.channelId);
    },
    async getPublicVideoStatsBatch(args: { credentials: ResolvedCredentials; videoIds: string[] }) {
      const youtube = await createAuthorizedClient(args.credentials);
      return getPublicVideoStatsBatch(youtube, args.videoIds);
    },
    // Phase 9 slice 9C (docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md).
    // Phase 13 slice 13.9.
    async getMostPopularMusicVideos(args: { credentials: ResolvedCredentials; regionCode: string }) {
      const youtube = await createAuthorizedClient(args.credentials);
      return getMostPopularMusicVideos(youtube, args.regionCode);
    },
    async searchPublicChannels(args: { credentials: ResolvedCredentials; query: string }) {
      const youtube = await createAuthorizedClient(args.credentials);
      return searchPublicChannels(youtube, args.query);
    },
    // Phase 9 slices 9B/9C (found by independent review): an upfront, cheap check the orchestrator
    // calls BEFORE claiming any channel or charging any quota unit -- without it, a client
    // construction failing on this exact toggle (a purely local check, never reaching YouTube's
    // network) still fell into the generic per-call catch block, which charged the full call cost
    // for spend that never actually happened.
    async assertReadsAvailable() {
      await assertDataApiReadsAuthorized();
    },
  };
}
