import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import {
  getLiveStream,
  getLiveStreamsSettingsJson,
  getStoredVideo,
  insertLiveStreamEvent,
  listLiveStreamVideos,
  setLiveStreamsSettingsJson,
  updateLiveStream,
} from "@/lib/db";
import { detectFfmpeg } from "@/lib/ffmpeg-host";
import { getProductionAppPaths } from "@/lib/platform-paths";
import { createBufferFs } from "./adapters/buffer-fs";
import { createLiveStreamsFiles } from "./adapters/files";
import { createHelperProcess, createSupervisorFiles } from "./adapters/helper-process";
import { createLiveStreamsStore } from "./adapters/store";
import { createLiveStreamsYoutubeReads } from "./adapters/youtube-api";
import { createLiveStreamBuffer } from "./buffer";
import { createLiveStreamsServices } from "./services";
import { createLiveStreamsSettings, liveStreamsHost } from "./settings";
import { createStreamSupervisor } from "./supervisor";

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

/** The server side of running streams on this computer (encoder helper, buffer, position, YouTube-ended detection). */
export function createStreamSupervisorCore() {
  const workspaces = createChannelWorkspacesCore();
  const files = createLiveStreamsFiles(async (channelId) => workspaces.getWorkspace({ channelId }));
  const bufferRoot = getProductionAppPaths().liveStreamsBufferDir;
  const event = async (channelId: string, kind: string, detail: Record<string, unknown>) =>
    insertLiveStreamEvent({ id: randomUUID(), channelId, at: new Date(), kind, detailJson: JSON.stringify(detail) });
  return createStreamSupervisor({
    bufferRoot,
    settings: () => createLiveStreamsSettingsCore().get(),
    streams: {
      get: (channelId) => getLiveStream(channelId),
      update: (channelId, set) => updateLiveStream(channelId, { ...set, updatedAt: new Date() }),
      videos: (channelId) => listLiveStreamVideos(channelId),
      recheck: async (channelId) => (await createLiveStreamsCore().recheckRotation(channelId)).playable,
      event,
    },
    buffer: createLiveStreamBuffer({ fs: createBufferFs(), bufferRoot, resolveOriginal: files.resolveOriginal, probe: files.probe, event, now: () => Date.now() }),
    ffmpeg: (dir) => detectFfmpeg({ configuredDir: dir }),
    youtube: createLiveStreamsYoutubeReads(),
    files: createSupervisorFiles(),
    process: createHelperProcess(),
    clock: () => new Date(),
    newToken: () => randomBytes(16).toString("hex"),
    random: (n) => randomInt(n),
  });
}

export * from "./contracts";
export { checkOriginal, checkPublicOnly, classifyRunEnd, locatePlayback, passLength, planBuffer, canCopyIntoBuffer } from "./rotation";
