import { createGoogleOAuthClient } from "@/lib/auth";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { createYoutubeClient } from "@/lib/youtube-read-gateway";
import { assertLiveWritesAuthorized, setVideoThumbnail } from "@/lib/youtube-write-gateway";

// BL-255 (ADR 0069): this module's one YouTube write, right after the Live writes check (AGENTS.md §G; gateway-inventory.test.ts).

export function authorizedOAuth(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({ access_token: credentials.accessToken, refresh_token: credentials.refreshToken });
  return oauth2;
}

export function createVideoThumbnailWrites() {
  return {
    async setThumbnail(credentials: ResolvedCredentials, videoId: string, image: { mimeType: "image/jpeg" | "image/png"; bytes: Buffer }) {
      const youtube = await createYoutubeClient(authorizedOAuth(credentials));
      await assertLiveWritesAuthorized();
      await setVideoThumbnail(youtube, videoId, image);
    },
  };
}
