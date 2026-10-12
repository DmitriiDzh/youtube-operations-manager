import { randomUUID } from "node:crypto";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { getLiveStreamsSettingsJson, getStoredVideo, setLiveStreamsSettingsJson } from "@/lib/db";
import { createLiveStreamsFiles } from "./adapters/files";
import { createLiveStreamsStore } from "./adapters/store";
import { createLiveStreamsYoutubeReads } from "./adapters/youtube-api";
import { createLiveStreamsServices } from "./services";
import { createLiveStreamsSettings, liveStreamsHost } from "./settings";

// BL-176 (docs/roadmap/plans/LIVE_STREAMS_PLAN.md, ADR 0036): the live-streams module wired to its real adapters.

export function createLiveStreamsCore() {
  const workspaces = createChannelWorkspacesCore();
  return createLiveStreamsServices({
    store: createLiveStreamsStore(),
    channelVideos: {
      async titleOf(channelId, videoId) {
        const video = await getStoredVideo(channelId, videoId);
        return video ? video.title : null;
      },
    },
    youtube: createLiveStreamsYoutubeReads(),
    files: createLiveStreamsFiles(async (channelId) => workspaces.getWorkspace({ channelId })),
    clock: () => new Date(),
    newId: () => randomUUID(),
  });
}

export type LiveStreamsCore = ReturnType<typeof createLiveStreamsCore>;

/** This computer's live-streams settings; the switch turns on only on the Mac's system service. */
export function createLiveStreamsSettingsCore() {
  return createLiveStreamsSettings({
    getJson: () => getLiveStreamsSettingsJson(),
    setJson: (json) => setLiveStreamsSettingsJson(json),
    host: () => liveStreamsHost({ platform: process.platform, serviceMode: process.env.YTOM_SERVICE_MODE }),
  });
}
export * from "./contracts";
export { checkOriginal, checkPublicOnly, classifyRunEnd, locatePlayback, passLength, planBuffer, canCopyIntoBuffer } from "./rotation";
