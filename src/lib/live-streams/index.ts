import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import {
  getLiveStream,
  getLiveWritesEnabled,
  getLiveStreamsSettingsJson,
  getStoredVideo,
  insertLiveStreamEvent,
  listLiveStreamVideos,
  listLiveStreams,
  setLiveStreamsSettingsJson,
  updateLiveStream,
} from "@/lib/db";
import { detectFfmpeg } from "@/lib/ffmpeg-host";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createWriteContextCore } from "@/lib/write-context";
import { getProductionAppPaths } from "@/lib/platform-paths";
import { createBufferFs } from "./adapters/buffer-fs";
import { createLiveStreamsFiles } from "./adapters/files";
import { createHelperProcess, createSupervisorFiles } from "./adapters/helper-process";
import { createLiveStreamsStore } from "./adapters/store";
import { createLiveStreamsYoutubeReads } from "./adapters/youtube-api";
import { createLiveStreamBuffer } from "./buffer";
import { createLiveBroadcasts } from "./broadcasts";
import { createLiveStreamsYoutubeWrites } from "./adapters/youtube-writes";
import { createLiveStreamsRunner } from "./runner";
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

/** The owner's attended actions: Start, Go live, Stop, Edit -- the only live-stream code that writes to YouTube. */
export function createLiveBroadcastsCore() {
  return createLiveBroadcasts({
    settings: () => createLiveStreamsSettingsCore().get(),
    liveWritesEnabled: () => getLiveWritesEnabled(),
    auth: { resolve: (args) => resolveGoogleCredentials(args as Parameters<typeof resolveGoogleCredentials>[0]) },
    writeContext: { assertWriteChannel: (args) => createWriteContextCore().assertWriteChannel(args as Parameters<ReturnType<typeof createWriteContextCore>["assertWriteChannel"]>[0]) },
    streams: {
      get: (channelId) => getLiveStream(channelId),
      update: (channelId, set) => updateLiveStream(channelId, { ...set, updatedAt: new Date() }),
      event: async (channelId, kind, detail) => insertLiveStreamEvent({ id: randomUUID(), channelId, at: new Date(), kind, detailJson: JSON.stringify(detail) }),
    },
    rotation: { recheck: async (channelId) => (await createLiveStreamsCore().recheckRotation(channelId)).playable },
    youtube: createLiveStreamsYoutubeWrites(),
    supervisor: createStreamSupervisorCore(),
    clock: () => new Date(),
  });
}

/** What the server does for live streams by itself (instrumentation's loop): restore, tend, read the broadcast. */
export function createLiveStreamsRunnerCore() {
  return createLiveStreamsRunner({
    settings: () => createLiveStreamsSettingsCore().get(),
    listStreams: () => listLiveStreams(),
    supervisor: createStreamSupervisorCore(),
    event: async (channelId, kind, detail) => insertLiveStreamEvent({ id: randomUUID(), channelId, at: new Date(), kind, detailJson: JSON.stringify(detail) }),
    now: () => Date.now(),
  });
}

export type { LiveStreamsRunner } from "./runner";
export * from "./contracts";
export { checkOriginal, checkPublicOnly, classifyRunEnd, locatePlayback, passLength, planBuffer, canCopyIntoBuffer } from "./rotation";
