import { createLocalizationStoreAdapter } from "./adapters/store";
import { createXlsxBuilder } from "./adapters/xlsx";
import { createLocalizationServices } from "./services";
import { getChannelExpectedLanguages } from "@/lib/db";

export function createLocalizationCore() {
  return createLocalizationServices({
    channelStore: createLocalizationStoreAdapter(),
    channelLanguageBaseline: {
      getExpectedDefaultLanguage: async (channelId) => (await getChannelExpectedLanguages(channelId)).defaultLanguage,
      getExpectedDefaultAudioLanguage: async (channelId) => (await getChannelExpectedLanguages(channelId)).defaultAudioLanguage,
    },
    xlsxBuilder: createXlsxBuilder(),
  });
}

export type LocalizationCore = ReturnType<typeof createLocalizationCore>;
