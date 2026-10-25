import { createGoogleOAuthClient } from "@/lib/auth";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { createYoutubeClient, getVideoMetadataContext } from "@/lib/youtube-read-gateway";
import { applyVideoMetadataUpdate, assertLiveWritesAuthorized } from "@/lib/youtube-write-gateway";
import type { LiveLocalizationsWriterDependencies } from "../contracts";

// BL-207 stage 3 (LIVE_LOCALIZATIONS_PLAN.md §2, ADR 0045): the writer's YouTube calls -- the fresh read through the read gateway,
// the one `videos.update part=snippet,localizations` through the write gateway with the shared Live-writes check (AGENTS.md §G;
// gateway-inventory.test.ts checks this file calls it). The service calls the check immediately before `update`.

async function clientFor(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({ access_token: credentials.accessToken, refresh_token: credentials.refreshToken });
  return createYoutubeClient(oauth2);
}

export function createLiveLocalizationsYoutubeAdapter(): LiveLocalizationsWriterDependencies["youtube"] {
  return {
    async readFresh(credentials, videoId) {
      const context = await getVideoMetadataContext(await clientFor(credentials), videoId);
      if (!context) return null;
      const snippet = context.snippet;
      return {
        snippet: { ...snippet, title: snippet.title ?? "", description: snippet.description ?? "", defaultLanguage: snippet.defaultLanguage ?? null },
        localizations: context.localizations,
      };
    },
    async assertLiveWritesAuthorized() {
      await assertLiveWritesAuthorized();
    },
    async update(credentials, videoId, payload) {
      // The service has just called `assertLiveWritesAuthorized` (above) immediately before this; no other caller exists.
      const youtube = await clientFor(credentials);
      await applyVideoMetadataUpdate({ youtube, update: { videoId, snippet: payload.snippet, localizations: payload.localizations } });
    },
  };
}
