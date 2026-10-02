import { getChannelExpectedLanguages, getStoredChannel, listStoredVideosByChannel, setChannelExpectedLanguages } from "@/lib/db";

export function createChannelLanguageDefaultsStoreAdapter() {
  return {
    getChannel: getStoredChannel,
    getDefaults: getChannelExpectedLanguages,
    setDefaults: setChannelExpectedLanguages,
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
