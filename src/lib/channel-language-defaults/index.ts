import { createChannelLanguageDefaultsStoreAdapter } from "./adapters/store";
import { createChannelLanguageDefaultsServices } from "./services";

export function createChannelLanguageDefaultsCore() {
  return createChannelLanguageDefaultsServices({ store: createChannelLanguageDefaultsStoreAdapter() });
}

export type ChannelLanguageDefaultsCore = ReturnType<typeof createChannelLanguageDefaultsCore>;
