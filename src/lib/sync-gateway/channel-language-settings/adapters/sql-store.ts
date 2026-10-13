import { getChannelExpectedLanguages, getChannelTargetLanguages, setChannelExpectedLanguages, setChannelTargetLanguages } from "@/lib/db";
import type { LocalLanguageSettingsStore } from "../services";

/**
 * This computer's copy of a channel's language settings: the `channels` columns every reader (Batches, Change Sets, AI,
 * Languages) already uses. This family is their only writer since BL-178 part B (`channel-language-defaults` and
 * `localization` save through it), so the columns follow the shared document.
 */
export function createSqlLocalStore(): LocalLanguageSettingsStore {
  return {
    async read(channelId) {
      const baseline = await getChannelExpectedLanguages(channelId);
      return {
        defaultLanguage: baseline.defaultLanguage,
        defaultAudioLanguage: baseline.defaultAudioLanguage,
        trackedLanguages: await getChannelTargetLanguages(channelId),
      };
    },
    async write(channelId, patch) {
      if (patch.defaultLanguage !== undefined || patch.defaultAudioLanguage !== undefined) {
        const current = await getChannelExpectedLanguages(channelId);
        await setChannelExpectedLanguages(channelId, {
          defaultLanguage: patch.defaultLanguage !== undefined ? patch.defaultLanguage : current.defaultLanguage,
          defaultAudioLanguage: patch.defaultAudioLanguage !== undefined ? patch.defaultAudioLanguage : current.defaultAudioLanguage,
        });
      }
      if (patch.trackedLanguages !== undefined) await setChannelTargetLanguages(channelId, patch.trackedLanguages);
    },
  };
}
