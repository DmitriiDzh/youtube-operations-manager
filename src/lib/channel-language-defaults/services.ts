import {
  DomainError,
  mapUnknownError,
  type ChannelLanguageDefaults,
  type LanguageDeviationReport,
  type StoredChannelRef,
  type StoredVideoLanguageRow,
} from "./contracts";
import { channelRefInputSchema, parseWithSchema, setDefaultsInputSchema } from "./schemas";
import { sameLanguage } from "@/lib/shared-language-baseline";

type ServiceDependencies = {
  store: {
    getChannel(channelId: string): Promise<StoredChannelRef | null>;
    getDefaults(channelId: string): Promise<ChannelLanguageDefaults>;
    /** Only the given fields change (BL-178 part B). */
    setDefaults(channelId: string, value: Partial<ChannelLanguageDefaults>): Promise<void>;
    listVideos(channelId: string): Promise<StoredVideoLanguageRow[]>;
    getConflictedFields?(channelId: string): Promise<string[]>;
  };
};

async function requireChannel(deps: ServiceDependencies, channelId: string) {
  const channel = await deps.store.getChannel(channelId);
  if (!channel) {
    throw new DomainError({ code: "not_found", message: "Channel has not been synchronized yet", details: { channelId } });
  }
  return channel;
}

/**
 * BL-178 part B: an unreadable shared document never breaks this report (review item 5), but it is flagged -- a write that
 * needs the computers to agree ("Fix all") refuses on the flag, as a Batch does (review re-check).
 */
async function conflictedFieldsOf(deps: ServiceDependencies, channelId: string): Promise<{ conflictedFields?: string[]; conflictedFieldsUnknown?: true }> {
  if (!deps.store.getConflictedFields) return {};
  try {
    return { conflictedFields: await deps.store.getConflictedFields(channelId) };
  } catch {
    return { conflictedFieldsUnknown: true };
  }
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

    /** Sets the given baseline fields (a field left out is unchanged; `null` clears it) and returns the whole baseline. Shared
     * with the owner's other computers since BL-178 part B; never a YouTube call. */
    async setDefaults(input: unknown): Promise<ChannelLanguageDefaults> {
      const parsed = parseWithSchema(setDefaultsInputSchema, input, "set language defaults input");
      try {
        await requireChannel(deps, parsed.channelId);
        const value: Partial<ChannelLanguageDefaults> = {};
        if (parsed.defaultLanguage !== undefined) value.defaultLanguage = parsed.defaultLanguage;
        if (parsed.defaultAudioLanguage !== undefined) value.defaultAudioLanguage = parsed.defaultAudioLanguage;
        await deps.store.setDefaults(parsed.channelId, value);
        return await deps.store.getDefaults(parsed.channelId);
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
            // Case-insensitive, the same rule as the Batch write and the agent context (BL-178).
            defaultLanguageDeviates: defaults.defaultLanguage !== null && !sameLanguage(video.defaultLanguage, defaults.defaultLanguage),
            defaultAudioLanguageDeviates:
              defaults.defaultAudioLanguage !== null && !sameLanguage(video.defaultAudioLanguage, defaults.defaultAudioLanguage),
          }))
          .filter((row) => row.defaultLanguageDeviates || row.defaultAudioLanguageDeviates);
        return {
          channelId,
          defaults,
          totalVideos: videos.length,
          defaultLanguageWritableViaApi: true,
          defaultAudioLanguageWritableViaApi: true,
          deviations,
          ...(await conflictedFieldsOf(deps, channelId)),
        };
      } catch (error) {
        throw mapUnknownError(error, "validation_failed");
      }
    },
  };
}
