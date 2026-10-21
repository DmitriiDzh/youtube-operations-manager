import { createGoogleOAuthClient } from "@/lib/auth";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { createYoutubeClient, getChannelLocalizationsContext } from "@/lib/youtube-read-gateway";
import { assertLiveWritesAuthorized, updateChannelBrandingChannel, updateChannelLocalizations } from "@/lib/youtube-write-gateway";
import type { ChannelLocalizationsDependencies } from "../contracts";

// BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md, ADR 0047): the channel translations writer's YouTube calls -- the read through the read
// gateway's barrel, the two `channels.update` writes through the write gateway with the shared Live-writes check (AGENTS.md §G;
// gateway-inventory.test.ts checks this file calls it). The service calls the check immediately before each write.

async function clientFor(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({ access_token: credentials.accessToken, refresh_token: credentials.refreshToken });
  return createYoutubeClient(oauth2);
}

export function createChannelLocalizationsYoutubeAdapter(): ChannelLocalizationsDependencies["youtube"] {
  return {
    async read(credentials, channelId) {
      const context = await getChannelLocalizationsContext(await clientFor(credentials), channelId);
      if (!context) return null;
      return { snippet: context.snippet, brandingChannel: context.brandingChannel, localizations: context.localizations };
    },
    async assertLiveWritesAuthorized() {
      await assertLiveWritesAuthorized();
    },
    async updateBrandingChannel(credentials, channelId, channel) {
      // The service has just called `assertLiveWritesAuthorized` (above) immediately before this.
      await updateChannelBrandingChannel({ youtube: await clientFor(credentials), channelId, channel });
    },
    async updateLocalizations(credentials, channelId, localizations) {
      // The service has just called `assertLiveWritesAuthorized` (above) immediately before this.
      await updateChannelLocalizations({ youtube: await clientFor(credentials), channelId, localizations });
    },
  };
}
