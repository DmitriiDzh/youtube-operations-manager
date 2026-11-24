// Package playlists (owner, Telegram 4858/4859): the real wiring of the video playlist membership read (`services.ts`). Reads only
// through the read gateway barrel (ADR 0007); the identity check is write-context's own (`assertWriteChannel`, the one guardrail).
// Its only caller is the Producer's `producer_video_playlists` (`src/lib/producer-mcp-endpoint/session-deps.ts`). The upload rows'
// playlist records come in through `uploadRecords` from the composition (the publishing module is not imported here, AGENTS.md §M).
import { YOUTUBE_READ_SCOPE, createGoogleOAuthClient } from "@/lib/auth";
import { getStoredVideo } from "@/lib/db";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { createWriteContextCore } from "@/lib/write-context";
import { createYoutubeClient, listPlaylistsForAuthenticated, playlistContainsVideo } from "@/lib/youtube-read-gateway";
import { runWithQuotaContext } from "@/lib/youtube-quota/context";
import { createMembershipCache, createVideoPlaylistMembership, type UploadPlaylistRecord, type VideoPlaylistsResult } from "./services";

export { MEMBERSHIP_CACHE_TTL_MS, MEMBERSHIP_MAX_PLAYLISTS } from "./services";
export type { UploadPlaylistRecord, VideoPlaylistsResult } from "./services";

/** The process's kept answers (MEMBERSHIP_CACHE_TTL_MS); a server restart starts empty. */
const processCache = createMembershipCache();

function client(credentials: unknown) {
  const resolved = credentials as ResolvedCredentials;
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({ access_token: resolved.accessToken, refresh_token: resolved.refreshToken });
  return createYoutubeClient(oauth2);
}

/**
 * `channelUser`: the account the channel is connected under here; `uploadRecords`: this computer's upload rows of the video with
 * their playlist step (the composition passes publishing's).
 */
export function createVideoPlaylistMembershipCore(options: {
  channelUser(channelId: string): Promise<string | null>;
  uploadRecords(channelId: string, videoId: string): Promise<UploadPlaylistRecord[]>;
}) {
  const writeContext = createWriteContextCore();
  const reader = createVideoPlaylistMembership(
    {
      channelUser: options.channelUser,
      async videoOfChannel(channelId, videoId) {
        if (await getStoredVideo(channelId, videoId)) return true;
        return (await options.uploadRecords(channelId, videoId)).length > 0;
      },
      uploadRecords: options.uploadRecords,
      credentials: (userId) => resolveGoogleCredentials({ credentialRef: { userId }, requiredScopes: [YOUTUBE_READ_SCOPE] }),
      async assertChannel({ channelId, userId, credentials }) {
        await writeContext.assertWriteChannel({ credentialRef: { userId }, credentials: credentials as ResolvedCredentials, expectedChannelId: channelId });
      },
      listPlaylists: async (credentials) => (await listPlaylistsForAuthenticated(await client(credentials))).map((p) => ({ id: p.id, title: p.title, privacyStatus: p.privacyStatus })),
      playlistHasVideo: async (credentials, playlistId, videoId) => playlistContainsVideo(await client(credentials), playlistId, videoId),
      clock: { now: () => new Date() },
    },
    processCache
  );
  return {
    videoPlaylists(input: { channelId: string; videoId: string; refresh?: boolean }): Promise<VideoPlaylistsResult> {
      return runWithQuotaContext({ kind: "video_playlists", id: input.videoId, label: `Playlists of ${input.videoId}` }, () => reader.videoPlaylists(input));
    },
  };
}
