import { createGoogleOAuthClient } from "@/lib/auth";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { createYoutubeClient } from "@/lib/youtube-read-gateway";
import {
  addVideoToPlaylistForAuthenticated,
  assertLiveWritesAuthorized,
  beginResumableVideoUpload,
  deleteVideoById,
  putVideoUploadChunk,
  queryVideoUploadOffset,
  setVideoThumbnail,
} from "@/lib/youtube-write-gateway";
import type { G1ProbeDependencies } from "../g1-probe";

// BL-182 (ADR 0037): every YouTube write of this module, each right after the Live writes check (AGENTS.md §G; enforced by
// `gateway-inventory.test.ts`). A long upload re-checks before every chunk, so turning Live writes off stops it at the next chunk.

export function authorizedOAuth(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({ access_token: credentials.accessToken, refresh_token: credentials.refreshToken });
  return oauth2;
}

/**
 * A fresh access token for the upload's own HTTPS requests (review minor): the stored token's expiry is not passed to the client,
 * so it would never refresh; marking it expired makes the client trade the refresh token for a new one.
 */
export async function freshAccessToken(credentials: ResolvedCredentials): Promise<string> {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({ access_token: credentials.accessToken, refresh_token: credentials.refreshToken, expiry_date: 1 });
  const { token } = await oauth2.getAccessToken();
  if (!token) throw new Error("Could not get an access token for the upload.");
  return token;
}

export function createPublishingYoutubeWrites(): G1ProbeDependencies["gateway"] {
  return {
    async begin(args) {
      await assertLiveWritesAuthorized();
      return beginResumableVideoUpload(args);
    },
    async putChunk(args) {
      await assertLiveWritesAuthorized();
      return putVideoUploadChunk(args);
    },
    async queryOffset(args) {
      await assertLiveWritesAuthorized();
      return queryVideoUploadOffset(args);
    },
    async deleteVideo(credentials, videoId) {
      const youtube = await createYoutubeClient(authorizedOAuth(credentials));
      await assertLiveWritesAuthorized();
      await deleteVideoById(youtube, videoId);
    },
  };
}

/** BL-182 stage 2: the upload runner's writes after the upload, each right after the Live writes check. */
export function createPublishingFinishWrites() {
  return {
    async setThumbnail(credentials: ResolvedCredentials, videoId: string, image: { mimeType: string; bytes: Buffer }) {
      const youtube = await createYoutubeClient(authorizedOAuth(credentials));
      await assertLiveWritesAuthorized();
      await setVideoThumbnail(youtube, videoId, { mimeType: image.mimeType === "image/png" ? "image/png" : "image/jpeg", bytes: image.bytes });
    },
    async addToPlaylist(credentials: ResolvedCredentials, videoId: string, playlistId: string) {
      const youtube = await createYoutubeClient(authorizedOAuth(credentials));
      await assertLiveWritesAuthorized();
      await addVideoToPlaylistForAuthenticated(youtube, videoId, playlistId);
    },
  };
}
