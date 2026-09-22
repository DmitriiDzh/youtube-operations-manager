import { resolveGoogleCredentials } from "@/lib/video-metadata/adapters/google-auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createAnalyticsStoreAdapter } from "./adapters/store";
import { createAnalyticsYoutubeApiAdapter } from "./adapters/youtube-api";
import { createDefaultLogger } from "./adapters/logger";
import { createAnalyticsServices } from "./services";

function defaultAuthResolver() {
  return {
    resolve: resolveGoogleCredentials,
  };
}

export function createAnalyticsCore() {
  const store = createAnalyticsStoreAdapter();
  return createAnalyticsServices({
    authResolver: defaultAuthResolver(),
    youtubeApi: createAnalyticsYoutubeApiAdapter(),
    videoStore: store.videoStore,
    metricStore: store.metricStore,
    logger: createDefaultLogger(),
    channelAccess: createChannelAccessCore(),
  });
}

export type AnalyticsCore = ReturnType<typeof createAnalyticsCore>;
export { ANALYTICS_METRIC_NAMES } from "./contracts";
export type { AnalyticsMetricName, CollectMetricsResult } from "./contracts";
