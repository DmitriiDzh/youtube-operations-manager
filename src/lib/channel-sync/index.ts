import { resolveGoogleCredentials } from "@/lib/video-metadata/adapters/google-auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createChannelSyncStoreAdapter } from "./adapters/store";
import { createChannelSyncYoutubeApiAdapter } from "./adapters/youtube-api";
import { createDefaultLogger } from "@/lib/shared-logger";
import { createChannelSyncServices } from "./services";

function defaultAuthResolver() {
  return {
    resolve: resolveGoogleCredentials,
  };
}

export function createChannelSyncCore() {
  return createChannelSyncServices({
    authResolver: defaultAuthResolver(),
    youtubeApi: createChannelSyncYoutubeApiAdapter(),
    channelStore: createChannelSyncStoreAdapter(),
    logger: createDefaultLogger(),
    channelAccess: createChannelAccessCore(),
  });
}

export type ChannelSyncCore = ReturnType<typeof createChannelSyncCore>;
