import {
  DomainError,
  mapUnknownError,
  type ChannelLanguageDefaults,
  type LanguageDeviationReport,
  type StoredChannelRef,
  type StoredVideoLanguageRow,
} from "./contracts";
import { channelRefInputSchema, parseWithSchema, setDefaultsInputSchema } from "./schemas";

type ServiceDependencies = {
  store: {
    getChannel(channelId: string): Promise<StoredChannelRef | null>;
    getDefaults(channelId: string): Promise<ChannelLanguageDefaults>;
    setDefaults(channelId: string, value: ChannelLanguageDefaults): Promise<void>;
    listVideos(channelId: string): Promise<StoredVideoLanguageRow[]>;
  };
};

async function requireChannel(deps: ServiceDependencies, channelId: string) {
  const channel = await deps.store.getChannel(channelId);
  if (!channel) {
    throw new DomainError({ code: "not_found", message: "Channel has not been synchronized yet", details: { channelId } });
  }
  return channel;
}

export function createChannelLanguageDefaultsServices(deps: ServiceDependencies) {
  return {
    async getDefaults(input: unknown): Promise<ChannelLanguageDefaults> {
      const { channelId } = parseWithSchema(channelRefInputSchema, input, "get language defaults input");
      try {
        await requireChannel(deps, channelId);
        return await deps.store.getDefaults(channelId);
      } catch (error) {
        throw mapUnknownError(error, "validation_failed");
      }
    },

    /** Full replace of the baseline; `null` clears a field. Local preference only -- no YouTube call. */
    async setDefaults(input: unknown): Promise<ChannelLanguageDefaults> {
      const parsed = parseWithSchema(setDefaultsInputSchema, input, "set language defaults input");
      try {
        await requireChannel(deps, parsed.channelId);
        const value = { defaultLanguage: parsed.defaultLanguage, defaultAudioLanguage: parsed.defaultAudioLanguage };
        await deps.store.setDefaults(parsed.channelId, value);
        return value;
      } catch (error) {
        throw mapUnknownError(error, "validation_failed");
      }
    },

    /** Videos whose synced defaultLanguage / defaultAudioLanguage differ from the chosen baseline.
     * A field with no baseline is never compared. A missing (null) value counts as a deviation
     * once a baseline exists -- for `defaultLanguage` that is also exactly what blocks a safe write. */
    async getDeviations(input: unknown): Promise<LanguageDeviationReport> {
      const { channelId } = parseWithSchema(channelRefInputSchema, input, "language deviations input");
      try {
        await requireChannel(deps, channelId);
        const defaults = await deps.store.getDefaults(channelId);
        const videos = await deps.store.listVideos(channelId);
        const deviations = videos
          .map((video) => ({
            ...video,
            defaultLanguageDeviates: defaults.defaultLanguage !== null && video.defaultLanguage !== defaults.defaultLanguage,
            defaultAudioLanguageDeviates:
              defaults.defaultAudioLanguage !== null && video.defaultAudioLanguage !== defaults.defaultAudioLanguage,
          }))
          .filter((row) => row.defaultLanguageDeviates || row.defaultAudioLanguageDeviates);
        return {
          channelId,
          defaults,
          totalVideos: videos.length,
          defaultLanguageWritableViaApi: true,
          defaultAudioLanguageWritableViaApi: true,
          deviations,
        };
      } catch (error) {
        throw mapUnknownError(error, "validation_failed");
      }
    },
  };
}
