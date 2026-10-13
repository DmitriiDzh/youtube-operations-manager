import { getChannelTargetLanguages, getStoredChannel, listStoredVideosByChannel } from "@/lib/db";
import { createChannelLanguageSettingsCoreForProduction } from "@/lib/sync-gateway";

export function createLocalizationStoreAdapter() {
  return {
    getChannel: getStoredChannel,
    listVideosByChannel: listStoredVideosByChannel,
    getTargetLanguages: getChannelTargetLanguages,
    // BL-178 part B: the tracked languages are the same on every computer -- saved through the sync-gateway family, which
    // also updates this computer's copy (`channels.target_languages_json`, read above).
    async setTargetLanguages(channelId: string, languages: string[]) {
      await createChannelLanguageSettingsCoreForProduction().save({ channelId, trackedLanguages: languages });
    },
    async getConflictedLanguageSettings(channelId: string): Promise<string[]> {
      return (await createChannelLanguageSettingsCoreForProduction().listConflicts(channelId)).map((c) => c.field);
    },
  };
}
