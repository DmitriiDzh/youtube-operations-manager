import {
  getChannelTargetLanguages,
  getStoredChannel,
  listStoredVideosByChannel,
  setChannelTargetLanguages,
} from "@/lib/db";

export function createLocalizationStoreAdapter() {
  return {
    getChannel: getStoredChannel,
    listVideosByChannel: listStoredVideosByChannel,
    getTargetLanguages: getChannelTargetLanguages,
    setTargetLanguages: setChannelTargetLanguages,
  };
}
