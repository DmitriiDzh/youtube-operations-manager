import { createGoogleOAuthClient } from "@/lib/auth";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { createYoutubeClient } from "@/lib/youtube-read-gateway";
import { assertLiveWritesAuthorized, insertVideoCaption, updateVideoCaption } from "@/lib/youtube-write-gateway";
import { markCaptionWriteNotSent } from "../contracts";

// BL-269 (ADR 0074 §1, §6, §10): this module's two YouTube writes, each right after the Live writes check (AGENTS.md §G;
// gateway-inventory.test.ts AC-CAP-23: the only caller of these primitives).

export function authorizedOAuth(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({ access_token: credentials.accessToken, refresh_token: credentials.refreshToken });
  return oauth2;
}

export type CaptionMedia = { mimeType: string; bytes: Buffer };

/**
 * The client, the Live writes check and the gateway calls are injectable for the order test (AC-CAP-12 / AC-CAP-44); the defaults are
 * the real ones. Order: client → Live writes → the one call, nothing in between. An error before the call carries the not-sent mark.
 */
export function createVideoCaptionWrites(
  deps: {
    client?: (credentials: ResolvedCredentials) => Promise<unknown>;
    assertLiveWrites?: () => Promise<void>;
    insert?: (youtube: never, args: { videoId: string; language: string; name: string; media: CaptionMedia }) => Promise<{ trackId: string }>;
    update?: (youtube: never, args: { trackId: string; media: CaptionMedia }) => Promise<void>;
  } = {}
) {
  const client = deps.client ?? ((credentials: ResolvedCredentials) => createYoutubeClient(authorizedOAuth(credentials)));
  const gate = deps.assertLiveWrites ?? (() => assertLiveWritesAuthorized());
  const insert = deps.insert ?? (insertVideoCaption as unknown as NonNullable<typeof deps.insert>);
  const update = deps.update ?? (updateVideoCaption as unknown as NonNullable<typeof deps.update>);
  /** The client and the Live writes check; an error here proves nothing was sent (review #3: the attempt mark is taken back). */
  async function ready(credentials: ResolvedCredentials): Promise<unknown> {
    try {
      const youtube = await client(credentials);
      await gate();
      return youtube;
    } catch (error) {
      throw markCaptionWriteNotSent(error);
    }
  }
  return {
    async insert(credentials: ResolvedCredentials, args: { videoId: string; language: string; name: string; media: CaptionMedia }): Promise<{ trackId: string }> {
      const youtube = await ready(credentials);
      return insert(youtube as never, args);
    },
    async update(credentials: ResolvedCredentials, args: { trackId: string; media: CaptionMedia }): Promise<void> {
      const youtube = await ready(credentials);
      await update(youtube as never, args);
    },
  };
}
