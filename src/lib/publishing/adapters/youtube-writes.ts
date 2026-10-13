import { createGoogleOAuthClient } from "@/lib/auth";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { createYoutubeClient } from "@/lib/youtube-read-gateway";
import { assertLiveWritesAuthorized, beginResumableVideoUpload, deleteVideoById, putVideoUploadChunk } from "@/lib/youtube-write-gateway";
import type { G1ProbeDependencies } from "../g1-probe";

// BL-182 (ADR 0037): every YouTube write of this module, each right after the Live writes check (AGENTS.md §G; enforced by
// `gateway-inventory.test.ts`). A long upload re-checks before every chunk, so turning Live writes off stops it at the next chunk.

export function authorizedOAuth(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({ access_token: credentials.accessToken, refresh_token: credentials.refreshToken });
  return oauth2;
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
    async deleteVideo(credentials, videoId) {
      const youtube = await createYoutubeClient(authorizedOAuth(credentials));
      await assertLiveWritesAuthorized();
      await deleteVideoById(youtube, videoId);
    },
  };
}
