import { createGoogleOAuthClient } from "@/lib/auth";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { createYoutubeClient, getChannelBrandingContext } from "@/lib/youtube-read-gateway";
import { assertLiveWritesAuthorized, insertChannelBanner, updateChannelBrandingSettings } from "@/lib/youtube-write-gateway";
import type { ChannelBrandingDependencies } from "../contracts";

// BL-223 (CHANNEL_BRANDING_PLAN.md, ADR 0050): the channel branding writer's YouTube calls -- the read through the read gateway's
// barrel, the banner upload and the one `channels.update part=brandingSettings` through the write gateway with the shared
// Live-writes check (AGENTS.md §G; gateway-inventory.test.ts checks this file calls it). The service calls the check immediately
// before each write.

async function clientFor(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({ access_token: credentials.accessToken, refresh_token: credentials.refreshToken });
  return createYoutubeClient(oauth2);
}

export function createChannelBrandingYoutubeAdapter(): ChannelBrandingDependencies["youtube"] {
  return {
    async read(credentials, channelId) {
      const context = await getChannelBrandingContext(await clientFor(credentials), channelId);
      if (!context) return null;
      return {
        title: context.title,
        avatarUrl: context.avatarUrl,
        customUrl: context.customUrl,
        brandingChannel: context.brandingChannel,
        bannerExternalUrl: context.bannerExternalUrl,
        localizations: context.localizations,
      };
    },
    async assertLiveWritesAuthorized() {
      await assertLiveWritesAuthorized();
    },
    async insertBanner(credentials, banner) {
      // The service has just called `assertLiveWritesAuthorized` (above) immediately before this.
      return insertChannelBanner(await clientFor(credentials), banner);
    },
    async updateBranding(credentials, channelId, brandingSettings) {
      // The service has just called `assertLiveWritesAuthorized` (above) immediately before this.
      await updateChannelBrandingSettings({ youtube: await clientFor(credentials), channelId, brandingSettings });
    },
  };
}
