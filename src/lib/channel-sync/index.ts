import { runWithQuotaContext } from "@/lib/youtube-quota";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { assertAgentScopeChannel, createChannelAccessCore, readStringField } from "@/lib/channel-access";
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
  const services = createChannelSyncServices({
    authResolver: defaultAuthResolver(),
    youtubeApi: createChannelSyncYoutubeApiAdapter(),
    channelStore: createChannelSyncStoreAdapter(),
    logger: createDefaultLogger(),
    channelAccess: createChannelAccessCore(),
  });
  // Phase 12 (docs/roadmap/plans/PHASE_12_PLAN.md 12.3, AC-P12-07): a channel-bound agent may sync
  // only its own channel -- an explicit other channelId would otherwise fetch it and overwrite its
  // row's connected_user_id. The implicit "my channel" path already resolves to the bound channel.
  return {
    ...services,
    async syncChannel(input: unknown, options?: Parameters<typeof services.syncChannel>[1]) {
      assertAgentScopeChannel(readStringField(input, "channelId"));
      return runWithQuotaContext({ kind: "channel_sync", id: null, label: "Channel sync" }, () => services.syncChannel(input, options));
    },
  };
}

export type ChannelSyncCore = ReturnType<typeof createChannelSyncCore>;
