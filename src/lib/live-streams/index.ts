import { randomBytes, randomInt, randomUUID } from "node:crypto";
import os from "node:os";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import {
  getLiveStream,
  getLiveWritesEnabled,
  listLiveStreamEvents,
  getLiveStreamsSettingsJson,
  getStoredVideo,
  insertLiveStreamEvent,
  listLiveStreamVideos,
  listLiveStreams,
  listStoredVideosByChannel,
  setLiveStreamsSettingsJson,
  updateLiveStream,
} from "@/lib/db";
import { detectFfmpeg } from "@/lib/ffmpeg-host";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { createWriteContextCore } from "@/lib/write-context";
import { getProductionAppPaths } from "@/lib/platform-paths";
import { createLiveStreamsShareCoreForProduction, LIVE_STREAMS_REPORT_FORMAT, LIVE_STREAMS_REPORT_VERSION, type SharedLiveStream } from "@/lib/sync-gateway";
import { getBootstrapDeviceId } from "./adapters/device-id";
import { createBufferFs } from "./adapters/buffer-fs";
import { createLiveStreamsFiles } from "./adapters/files";
import { createPickerFiles } from "./adapters/picker-files";
import { createHelperProcess, createSupervisorFiles } from "./adapters/helper-process";
import { createLiveStreamsStore } from "./adapters/store";
import { createLiveStreamsYoutubeReads } from "./adapters/youtube-api";
import { createLiveStreamBuffer } from "./buffer";
import { createLiveBroadcasts } from "./broadcasts";
import { createLiveStreamsYoutubeWrites } from "./adapters/youtube-writes";
import { createLiveStreamsRunner } from "./runner";
import { liveNotices, type LiveNotice } from "./notices";
import { createRotationPicker } from "./picker-service";
import { streamReportEntry, type StreamReportEntry } from "./report";
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

/** BL-187: the «Добавить видео…» dialog's list -- `04 Videos/` of the channel workspace matched to the channel's videos. Read-only. */
export function createRotationPickerCore() {
  const workspaces = createChannelWorkspacesCore();
  const store = createLiveStreamsStore();
  return createRotationPicker({
    ...createPickerFiles(),
    workspace: (channelId) => workspaces.getWorkspace({ channelId }),
    async channelVideos(channelId) {
      return (await listStoredVideosByChannel(channelId)).map((v) => ({
        videoId: v.videoId,
        title: v.title,
        privacyStatus: v.privacyStatus,
        publishAt: v.publishAt,
        publishedAt: v.publishedAt || null,
        durationSeconds: v.durationSeconds,
        thumbnailUrl: (v.thumbnails.medium ?? v.thumbnails.default ?? Object.values(v.thumbnails)[0])?.url ?? null,
      }));
    },
    rotation: async (channelId) => (await store.listVideos(channelId)).map((v) => ({ videoId: v.videoId, originalPath: v.originalPath })),
    sources: async (channelId) => (await store.listSources(channelId)).map((s) => ({ videoId: s.videoId, originalPath: s.originalPath })),
    clock: () => new Date(),
  });
}

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
  const event = async (channelId: string, kind: string, detail: Record<string, unknown>, at?: Date) =>
    insertLiveStreamEvent({ id: randomUUID(), channelId, at: at ?? new Date(), kind, detailJson: JSON.stringify(detail) });
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

/** §3.10/§3.11: every stream on this computer in the shared vocabulary (the page, the report, the Operator). Local reads only. */
export async function collectLiveStreamEntries(now: number = Date.now()): Promise<StreamReportEntry[]> {
  const supervisor = createStreamSupervisorCore();
  return Promise.all(
    (await listLiveStreams()).map(async (stream) => {
      const [status, poll, events, videos] = await Promise.all([
        supervisor.readStatus(stream.channelId),
        supervisor.lastYoutubePoll(stream.channelId),
        listLiveStreamEvents(stream.channelId, 50),
        listLiveStreamVideos(stream.channelId),
      ]);
      const last = events.find((e) => e.kind === "youtube_ended" || e.kind === "encoder_start");
      return streamReportEntry(
        {
          channelId: stream.channelId,
          intent: stream.intent,
          onSince: stream.onSince?.getTime() ?? null,
          helper: status
            ? { state: status.state, updatedAt: status.updatedAt, position: { index: status.position.index, videoId: status.position.videoId }, lastExit: status.lastExit ? { at: status.lastExit.at, cause: status.lastExit.cause } : null, missingVideoId: status.missingVideoId ?? null }
            : null,
          // "N of M": the pass's length (only playable videos), not the rotation's.
          rotationSize: status?.passVideoIds?.length ?? (stream.passOrderJson ? (JSON.parse(stream.passOrderJson) as string[]).length : videos.length),
          youtube: poll ? { lifeCycleStatus: poll.lifeCycleStatus, streamStatus: poll.streamStatus, healthStatus: poll.healthStatus, issueTypes: poll.configurationIssues.map((i) => i.type), viewers: poll.viewers } : null,
          lastEndOrStart: last ? (last.kind as "youtube_ended" | "encoder_start") : null,
        },
        now
      );
    })
  );
}

/** This computer's name as other computers show it ("on <host>"), or null when it has no usable name. */
function hostName(): string | null {
  const name = os.hostname().replace(/\.local$/, "").replace(/[^\p{L}\p{N} ._'-]/gu, "").slice(0, 64);
  return name.length > 0 ? name : null;
}

/** §3.11: publishes this computer's live-streams report for the sync family (`streams: []` while the module is off). */
export async function publishLiveStreamsReport(options: { enabled: boolean }): Promise<void> {
  const streams: SharedLiveStream[] = options.enabled ? await collectLiveStreamEntries() : [];
  await createLiveStreamsShareCoreForProduction().publishLocalReport({
    format: LIVE_STREAMS_REPORT_FORMAT,
    version: LIVE_STREAMS_REPORT_VERSION,
    deviceId: await getBootstrapDeviceId(),
    hostName: hostName(),
    updatedAt: new Date().toISOString(),
    streams,
  });
}

/** §3.11: the other computers' streams (read-only), newest report first. */
export async function listPeerLiveStreams(): Promise<Array<{ deviceId: string; hostName: string | null; updatedAt: string; streams: SharedLiveStream[] }>> {
  return (await createLiveStreamsShareCoreForProduction().listPeerReports()).map((r) => ({ deviceId: r.deviceId, hostName: r.hostName, updatedAt: r.updatedAt, streams: r.streams }));
}

/** What the server does for live streams by itself (instrumentation's loop): restore, tend, read the broadcast. */
export function createLiveStreamsRunnerCore() {
  return createLiveStreamsRunner({
    settings: () => createLiveStreamsSettingsCore().get(),
    listStreams: () => listLiveStreams(),
    supervisor: createStreamSupervisorCore(),
    event: async (channelId, kind, detail) => insertLiveStreamEvent({ id: randomUUID(), channelId, at: new Date(), kind, detailJson: JSON.stringify(detail) }),
    publish: (enabled) => publishLiveStreamsReport({ enabled }),
    now: () => Date.now(),
  });
}

/** §3.10: the bell's live-stream notices for this computer's streams. Local reads only (files and the database). */
export function createLiveStreamsNoticesCore() {
  const supervisor = createStreamSupervisorCore();
  return {
    async list(now: number = Date.now()): Promise<LiveNotice[]> {
      const settings = await createLiveStreamsSettingsCore().get();
      if (!settings.enabled || !settings.host.ok) return [];
      const inputs = await Promise.all(
        (await listLiveStreams()).map(async (stream) => {
          const [status, poll, events] = await Promise.all([supervisor.readStatus(stream.channelId), supervisor.lastYoutubePoll(stream.channelId), listLiveStreamEvents(stream.channelId, 50)]);
          const ended = events.find((e) => e.kind === "youtube_ended" || e.kind === "encoder_start");
          return {
            channelId: stream.channelId,
            intent: stream.intent,
            onSince: stream.onSince?.getTime() ?? null,
            helper: status ? { state: status.state, updatedAt: status.updatedAt, lastExitAt: status.lastExit?.at ?? null, missingVideoId: status.missingVideoId ?? null } : null,
            youtube: poll ? { checkedAt: poll.checkedAt, lifeCycleStatus: poll.lifeCycleStatus, notLiveSince: poll.notLiveSince } : null,
            endedAt: ended?.kind === "youtube_ended" ? ended.at.getTime() : null,
          };
        })
      );
      return liveNotices(inputs, now, settings.alertMinutes);
    },
  };
}

export { getBootstrapDeviceId as getLiveStreamsDeviceId } from "./adapters/device-id";
export type { LiveNotice } from "./notices";
export type { StreamReportEntry, LiveStreamState } from "./report";
export type { LiveStreamsRunner } from "./runner";
export * from "./contracts";
export type { PickerRow, PickerRowState, PickerVideo, MatchSource } from "./picker";
export type { PickerResult } from "./picker-service";
export { checkOriginal, checkPublicOnly, classifyRunEnd, locatePlayback, passLength, planBuffer, canCopyIntoBuffer } from "./rotation";
