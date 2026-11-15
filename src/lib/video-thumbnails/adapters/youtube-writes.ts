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

/**
 * The client, the Live writes check and the gateway call are injectable for the order test (AC-TH-07); the defaults are the real
 * ones. Order: client → Live writes → `thumbnails.set`, nothing in between.
 */
export function createVideoThumbnailWrites(
  deps: {
    client?: (credentials: ResolvedCredentials) => Promise<unknown>;
    assertLiveWrites?: () => Promise<void>;
    write?: (youtube: never, videoId: string, image: { mimeType: "image/jpeg" | "image/png"; bytes: Buffer }) => Promise<void>;
  } = {}
) {
  const client = deps.client ?? ((credentials: ResolvedCredentials) => createYoutubeClient(authorizedOAuth(credentials)));
  const gate = deps.assertLiveWrites ?? (() => assertLiveWritesAuthorized());
  const write = deps.write ?? (setVideoThumbnail as unknown as NonNullable<typeof deps.write>);
  return {
    async setThumbnail(credentials: ResolvedCredentials, videoId: string, image: { mimeType: "image/jpeg" | "image/png"; bytes: Buffer }) {
      const youtube = await client(credentials);
      await gate();
      await write(youtube as never, videoId, image);
    },
  };
}
