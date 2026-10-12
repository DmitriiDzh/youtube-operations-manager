import { getChannelExpectedLanguages, getStoredChannel, listStoredVideosByChannel } from "@/lib/db";
import { createChannelLanguageSettingsCoreForProduction } from "@/lib/sync-gateway";
import type { ChannelLanguageDefaults } from "../contracts";

export function createChannelLanguageDefaultsStoreAdapter() {
  return {
    getChannel: getStoredChannel,
    getDefaults: getChannelExpectedLanguages,
    // BL-178 part B: the baseline is the same on every computer -- saved through the sync-gateway family, which also updates
    // this computer's copy (`channels.expected_default_*`, read above).
    async setDefaults(channelId: string, value: ChannelLanguageDefaults) {
      await createChannelLanguageSettingsCoreForProduction().save({ channelId, ...value });
    },
    /** The baseline fields set differently on the computers (shown on the Languages page; Batches refuse meanwhile). */
    async getConflictedFields(channelId: string): Promise<string[]> {
      const conflicts = await createChannelLanguageSettingsCoreForProduction().listConflicts(channelId);
      return conflicts.map((c) => c.field).filter((field) => field === "defaultLanguage" || field === "defaultAudioLanguage");
    },
    async listVideos(channelId: string) {
      const videos = await listStoredVideosByChannel(channelId);
      return videos.map((v) => ({
        videoId: v.videoId,
        title: v.title,
        defaultLanguage: v.defaultLanguage,
        defaultAudioLanguage: v.defaultAudioLanguage,
      }));
    },
  };
}
