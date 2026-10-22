import { randomBytes, randomInt, randomUUID } from "node:crypto";
import os from "node:os";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { getChannelExpectedLanguages, listLiveStreamEventsOfKind, listLiveStreamSegments, latestLiveStreamEvent, getStoredChannel, listOpenLiveStreamSegments, updateLiveStreamSegment, insertLiveStreamSegment, countLiveStreamEvents,
  getLiveStream,
  getLiveWritesEnabled,
  listLiveStreamEvents,
  getLiveStreamsSettingsJson,
  getStoredVideo,
  insertLiveStreamEvent,
  insertLiveViewerSample,
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
import { createThumbnailFs } from "./adapters/thumbnail-fs";
import { createLiveStreamsYoutubeReads } from "./adapters/youtube-api";
import { createLiveStreamBuffer } from "./buffer";
import type { LocalizationsPort, VideoFieldsPort } from "./video-apply";
import { createStreamLocalizations } from "./localizations";
import { createLiveBroadcasts } from "./broadcasts";
import { createLiveStreamsYoutubeWrites } from "./adapters/youtube-writes";
import { createLiveStreamsRunner } from "./runner";
import { DomainError as SegmentsDomainError } from "./contracts";
import { createLiveSegments, parseSegmentSettingsInput, segmentsView, type LiveSegments, type SegmentSettings, type SegmentsView } from "./segments";
import { readStoredVideoSettings } from "./video-settings";
import { isRedundantTransition } from "./errors";
import { liveNotices, type LiveNotice } from "./notices";
import { createRotationPicker } from "./picker-service";
import { streamReportEntry, type StreamReportEntry } from "./report";
import { createLiveStreamsServices } from "./services";
import { createLiveStreamsSettings, liveStreamsHost } from "./settings";
import { createStreamSupervisor, isChannelLockBusy, withChannelLock } from "./supervisor";
import { createStreamVideoSettings } from "./video-settings";

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

/** BL-186: the stream's own video and broadcast settings and its thumbnail, saved on this computer. Local only. */
export function createStreamVideoSettingsCore() {
  return createStreamVideoSettings({
    store: createLiveStreamsStore(),
    thumbnails: createThumbnailFs(getProductionAppPaths().liveStreamsThumbnailsDir),
    clock: () => new Date(),
    newId: () => randomUUID(),
  });
}

/** BL-207: the stream's title/description translations, saved on this computer (one set per stream). Local only. */
export function createStreamLocalizationsCore() {
  return createStreamLocalizations({
    store: createLiveStreamsStore(),
    channelLanguage: async (channelId) => (await getChannelExpectedLanguages(channelId)).defaultLanguage,
    readVideoSettings: readStoredVideoSettings,
    lastApplied: async (channelId) => latestLiveStreamEvent(channelId, "video_settings_applied"),
    clock: () => new Date(),
    newId: () => randomUUID(),
  });
}

/** The video-level writers the app layer plugs in (AGENTS.md §M): video-details/playlist-management (BL-186), live-localizations
 * (BL-207). Either absent: Start works as before and that part is reported as not applied. */
export type LiveVideoWriters = { videoFields?: VideoFieldsPort; localizations?: LocalizationsPort };

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
      sample: (channelId, sample) => insertLiveViewerSample({ channelId, ...sample }),
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

/**
 * The owner's attended actions: Start, Go live, Stop, Edit, Apply again -- the only live-stream code that writes to YouTube.
 * `videoFields` (BL-186 stage 3) is plugged in by the app layer: this module imports no other feature module (AGENTS.md §M).
 */
export function createLiveBroadcastsCore(options: LiveVideoWriters = {}) {
  const thumbnails = createThumbnailFs(getProductionAppPaths().liveStreamsThumbnailsDir);
  return createLiveBroadcasts({
    videoFields: options.videoFields,
    localizations: options.localizations,
    channelLanguage: async (channelId) => (await getChannelExpectedLanguages(channelId)).defaultLanguage,
    thumbnails: { read: (channelId) => thumbnails.read(channelId) },
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
/**
 * BL-205 (LIVE_SEGMENTS_PLAN.md): the segment switcher. Its writes are the app's own (ADR 0044), made with the channel's connected
 * account after Live writes and the identity check, each through the gateway adapter. `videoFields` is plugged in by the app layer.
 */
export function createLiveSegmentsCore(options: LiveVideoWriters = {}): LiveSegments {
  const writes = createLiveStreamsYoutubeWrites();
  const broadcasts = createLiveBroadcastsCore(options);
  const supervisor = createStreamSupervisorCore();
  const event = async (channelId: string, kind: string, detail: Record<string, unknown>) =>
    insertLiveStreamEvent({ id: randomUUID(), channelId, at: new Date(), kind, detailJson: JSON.stringify(detail) });
  return createLiveSegments({
    streams: {
      get: (channelId) => getLiveStream(channelId),
      update: (channelId, set) => updateLiveStream(channelId, { ...set, updatedAt: new Date() }),
      event,
      countEventsSince: (channelId, kinds, since) => countLiveStreamEvents(channelId, kinds, since),
    },
    segments: {
      insert: (row) => insertLiveStreamSegment(row),
      update: (id, set) => updateLiveStreamSegment(id, set),
      open: (channelId) => listOpenLiveStreamSegments(channelId),
    },
    broadcastSettings: async (channelId) => {
      const stored = readStoredVideoSettings((await getLiveStream(channelId))?.videoSettingsJson);
      return stored.ok && stored.settings ? stored.settings.broadcast : null;
    },
    authorize: async (channelId) => {
      if (!(await getLiveWritesEnabled())) throw new Error("Live writes are off (Settings)");
      const channel = await getStoredChannel(channelId);
      if (!channel?.connectedUserId) throw new Error("The channel has no connected account");
      const credentialRef = { userId: channel.connectedUserId };
      const credentials = await resolveGoogleCredentials({ credentialRef, requiredScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"] });
      await createWriteContextCore().assertWriteChannel({ credentialRef, credentials, expectedChannelId: channelId });
      return { credentialRef, credentials };
    },
    youtube: {
      insertBroadcast: (credentials, args) => writes.insertBroadcast(credentials, args),
      bind: (credentials, args) => writes.bind(credentials, args),
      transition: async (credentials, args) => {
        try {
          return await writes.transition(credentials, args);
        } catch (error) {
          if (isRedundantTransition(error)) return { lifeCycleStatus: args.broadcastStatus };
          throw error;
        }
      },
      lifecycles: async (credentials, ids) => {
        const out: Record<string, { lifeCycleStatus: string | null; actualStartTime: string | null; actualEndTime: string | null; recordFromStart: boolean | null }> = {};
        for (const id of ids) {
          const b = await writes.getBroadcast(credentials, id);
          if (b) out[id] = { lifeCycleStatus: b.lifeCycleStatus, actualStartTime: b.actualStartTime ?? null, actualEndTime: b.actualEndTime ?? null, recordFromStart: b.recordFromStart ?? null };
        }
        return out;
      },
      deleteVideo: (credentials, videoId) => writes.deleteVideo(credentials, videoId),
      playlistHasVideo: (credentials, playlistId, videoId) => writes.playlistHasVideo(credentials, playlistId, videoId),
    },
    applyVideoSettings: (args) => broadcasts.applyVideoSettingsForSegment(args),
    addToPlaylist: options.videoFields ? (args) => options.videoFields!.addToPlaylist(args) : undefined,
    playedVideos: async (channelId) => (await supervisor.readStatus(channelId))?.passVideoIds ?? [],
    newId: () => randomUUID(),
    clock: () => Date.now(),
    // The same key as the owner's Start, Stop and Edit (broadcasts.ts): a switch step never runs at the same time as them.
    // Never waits: a busy lock (the owner's Stop/Edit/Go live) skips this tick's step; the next tick does it.
    withBroadcastLock: (channelId, fn) => (isChannelLockBusy(`broadcast:${channelId}`) ? Promise.resolve(undefined) : withChannelLock(`broadcast:${channelId}`, fn)),
  });
}

export function createLiveStreamsRunnerCore(options: LiveVideoWriters = {}) {
  return createLiveStreamsRunner({
    settings: () => createLiveStreamsSettingsCore().get(),
    listStreams: () => listLiveStreams(),
    supervisor: createStreamSupervisorCore(),
    segments: createLiveSegmentsCore(options),
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
          const [status, poll, events, switched, switchFailed] = await Promise.all([
            supervisor.readStatus(stream.channelId),
            supervisor.lastYoutubePoll(stream.channelId),
            listLiveStreamEvents(stream.channelId, 50),
            latestLiveStreamEvent(stream.channelId, "live_segment_switched"),
            latestLiveStreamEvent(stream.channelId, "live_segment_switch_failed"),
          ]);
          const ended = events.find((e) => e.kind === "youtube_ended" || e.kind === "encoder_start");
          return {
            channelId: stream.channelId,
            intent: stream.intent,
            onSince: stream.onSince?.getTime() ?? null,
            helper: status ? { state: status.state, updatedAt: status.updatedAt, lastExitAt: status.lastExit?.at ?? null, missingVideoId: status.missingVideoId ?? null } : null,
            youtube: poll ? { checkedAt: poll.checkedAt, lifeCycleStatus: poll.lifeCycleStatus, notLiveSince: poll.notLiveSince } : null,
            endedAt: ended?.kind === "youtube_ended" ? ended.at.getTime() : null,
            segmentSwitchFailedAt: switchFailed && (!switched || switched.at < switchFailed.at) ? switchFailed.at.getTime() : null,
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

export type { LocalizationsPort, VideoFieldsPort, VideoApplyResult } from "./video-apply";
export { LIVE_LOCALIZATIONS_MAX_LANGUAGES, localizationsStatusEntry, readStoredLocalizations, validateLiveLocalizations } from "./localizations";
export type { LiveLocalization, LiveLocalizationRefusal, LiveLocalizationSet, LiveLocalizationsValidation, LiveLocalizationsView, LiveLocalizationsWarning, LiveLocalizationsLastStep, LiveLocalizationsStatusEntry, StoredLocalizations } from "./localizations";

/** BL-205: the segment settings (local, no YouTube write) and the segments view for the page and the Operator. Local reads only. */
export function createLiveSegmentSettingsCore() {
  return {
    async save(channelId: string, input: unknown) {
      let settings: SegmentSettings;
      try {
        settings = parseSegmentSettingsInput(input);
      } catch (error) {
        throw new SegmentsDomainError({ code: "validation_failed", message: `Invalid segment settings: ${error instanceof Error ? error.message : String(error)}`, details: { channelId } });
      }
      const stream = await getLiveStream(channelId);
      if (!stream) throw new SegmentsDomainError({ code: "validation_failed", message: "Save the stream's settings first", details: { channelId } });
      await updateLiveStream(channelId, { segmentsJson: JSON.stringify(settings), updatedAt: new Date() });
      await insertLiveStreamEvent({ id: randomUUID(), channelId, at: new Date(), kind: "segments_saved", detailJson: JSON.stringify({ enabled: settings.enabled, lengthMinutes: settings.lengthMinutes, switchHourUtc: settings.switchHourUtc, recordingsPlaylistId: settings.recordingsPlaylist?.id ?? null }) });
      return settings;
    },
    async view(channelId: string, now: number = Date.now()): Promise<SegmentsView | null> {
      const stream = await getLiveStream(channelId);
      if (!stream) return null;
      const since = new Date(now - 30 * 86_400_000);
      const [rows, failures, switched] = await Promise.all([
        listLiveStreamSegments(channelId, since),
        listLiveStreamEventsOfKind(channelId, "live_segment_switch_failed", since),
        latestLiveStreamEvent(channelId, "live_segment_switched"),
      ]);
      return segmentsView({
        channelId,
        settingsJson: stream.segmentsJson,
        broadcastId: stream.broadcastId,
        intent: stream.intent,
        rows,
        failures: failures.map((f) => ({ at: f.at, detail: JSON.parse(f.detailJson) as Record<string, unknown> })),
        lastSwitchedAt: switched?.at ?? null,
      });
    },
  };
}
export type { SegmentsView, SegmentSettings } from "./segments";
