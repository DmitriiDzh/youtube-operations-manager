import {
  DomainError,
  DURATION_TOLERANCE_SECONDS,
  MAX_AUDIO_CHANNELS,
  SUPPORTED_AUDIO_SAMPLE_RATES,
  type LiveStreamEventKind,
  type ProbeResult,
  type RotationVideoView,
  type SourceItemResult,
  type StreamSettingsInput,
  type StreamView,
  type VideoFacts,
  type VideoRefusal,
} from "./contracts";
import { checkOriginal, checkPublicOnly } from "./rotation";
import {
  addVideoSchema,
  overrideGuardSchema,
  parseWithSchema,
  removeVideoSchema,
  reorderSchema,
  sourcesSchema,
  streamSettingsSchema,
} from "./schemas";

// ---------------------------------------------------------------------------
// BL-176 (LIVE_STREAMS_PLAN.md §3.3–§3.5) -- the rotation: what a channel's stream plays, checked against YouTube (fresh,
// never the synced copy) and against the files on this computer. Local only: nothing here writes to YouTube.
// ---------------------------------------------------------------------------

export type StoredStreamRow = {
  channelId: string;
  intent: "on" | "off";
  streamId: string | null;
  broadcastId: string | null;
  title: string;
  description: string;
  privacyStatus: "public" | "unlisted" | "private";
  madeForKids: boolean;
  orderMode: "sequence" | "shuffle";
  passNumber: number;
  passOrderJson: string | null;
  nextPassOrderJson: string | null;
  positionIndex: number;
  positionOffsetSeconds: number;
  positionUpdatedAt: Date | null;
  onSince: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredVideoRow = {
  channelId: string;
  videoId: string;
  rotationIndex: number;
  originalPath: string;
  videoDurationSeconds: number | null;
  originalDurationSeconds: number | null;
  originalBytes: number | null;
  checkStatus: "ok" | "refused" | "unchecked";
  checkReason: string | null;
  checkedAt: Date | null;
  guardOverrideReason: string | null;
  guardOverrideAt: Date | null;
  addedAt: Date;
};

export type LiveStreamsDependencies = {
  store: {
    getStream(channelId: string): Promise<StoredStreamRow | null>;
    upsertStream(row: Omit<StoredStreamRow, "positionUpdatedAt" | "onSince" | "passOrderJson" | "nextPassOrderJson" | "streamId" | "broadcastId"> & Partial<StoredStreamRow>): Promise<void>;
    /** Some columns of an existing row only (never the stream's ids, intent or position). */
    updateStream(channelId: string, set: Partial<Pick<StoredStreamRow, "title" | "description" | "privacyStatus" | "madeForKids" | "orderMode" | "updatedAt">>): Promise<boolean>;
    listVideos(channelId: string): Promise<StoredVideoRow[]>;
    upsertVideo(row: StoredVideoRow): Promise<void>;
    updateVideo(channelId: string, videoId: string, set: Partial<Omit<StoredVideoRow, "channelId" | "videoId" | "addedAt">>): Promise<boolean>;
    deleteVideo(channelId: string, videoId: string): Promise<boolean>;
    setOrder(channelId: string, videoIds: readonly string[]): Promise<boolean>;
    insertEvent(row: { id: string; channelId: string; at: Date; kind: string; detailJson: string }): Promise<void>;
    upsertSource(row: { channelId: string; videoId: string; originalPath: string; setBy: string; setAt: Date }): Promise<void>;
    listSources(channelId: string): Promise<Array<{ videoId: string; originalPath: string; setBy: string; setAt: Date }>>;
  };
  /** The channel's own videos as synced here: proves a video id belongs to the channel (§6.6 channel context). */
  channelVideos: { titleOf(channelId: string, videoId: string): Promise<string | null> };
  /** A fresh YouTube read of the videos' privacy, scheduled time and duration. Ids YouTube does not return are absent. */
  youtube: { readVideoFacts(channelId: string, videoIds: readonly string[]): Promise<VideoFacts[]> };
  files: {
    resolveOriginal(channelId: string, relativePath: string): Promise<{ ok: true; path: string; bytes: number } | { ok: false; workspaceMissing: boolean; detail: string }>;
    probe(path: string): Promise<ProbeResult>;
  };
  clock: () => Date;
  newId: () => string;
};

const DEFAULT_SETTINGS: StreamSettingsInput = { title: "", description: "", privacyStatus: "unlisted", madeForKids: false, orderMode: "sequence" };

function refused(reason: VideoRefusal, detail: string, videoId: string): DomainError {
  return new DomainError({ code: "live_stream_video_refused", message: `The video cannot be streamed: ${detail}`, details: { videoId, reason } });
}

function toView(row: StoredVideoRow, title: string | null): RotationVideoView {
  return {
    videoId: row.videoId,
    title,
    rotationIndex: row.rotationIndex,
    originalPath: row.originalPath,
    videoDurationSeconds: row.videoDurationSeconds,
    originalDurationSeconds: row.originalDurationSeconds,
    originalBytes: row.originalBytes,
    check: { status: row.checkStatus, reason: row.checkReason, checkedAt: row.checkedAt?.toISOString() ?? null },
    override: row.guardOverrideReason && row.guardOverrideAt ? { reason: row.guardOverrideReason, at: row.guardOverrideAt.toISOString() } : null,
  };
}

export function createLiveStreamsServices(deps: LiveStreamsDependencies) {
  async function event(channelId: string, kind: LiveStreamEventKind, detail: Record<string, unknown>): Promise<void> {
    await deps.store.insertEvent({ id: deps.newId(), channelId, at: deps.clock(), kind, detailJson: JSON.stringify(detail) });
  }

  /** The file checks of §3.5 for one video and one workspace-relative path: a refusal, or the facts to store. */
  async function checkFile(
    channelId: string,
    videoId: string,
    relativePath: string,
    youtubeDurationSeconds: number | null
  ): Promise<{ ok: true; durationSeconds: number | null; bytes: number } | { ok: false; reason: VideoRefusal; detail: string }> {
    const resolved = await deps.files.resolveOriginal(channelId, relativePath);
    if (!resolved.ok) {
      if (resolved.workspaceMissing) {
        throw new DomainError({ code: "live_stream_workspace_unavailable", message: resolved.detail, details: { channelId } });
      }
      return { ok: false, reason: "file_unavailable", detail: resolved.detail };
    }
    let probe: ProbeResult;
    try {
      probe = await deps.files.probe(resolved.path);
    } catch (error) {
      return { ok: false, reason: "file_unavailable", detail: `the file could not be read as a video (${error instanceof Error ? error.message : String(error)})` };
    }
    const problem = checkOriginal(probe, youtubeDurationSeconds, {
      toleranceSeconds: DURATION_TOLERANCE_SECONDS,
      sampleRates: SUPPORTED_AUDIO_SAMPLE_RATES,
      maxChannels: MAX_AUDIO_CHANNELS,
    });
    if (problem) {
      const detail =
        problem === "duration_mismatch"
          ? `the file lasts ${probe.durationSeconds?.toFixed(1)} s and the YouTube video ${youtubeDurationSeconds} s`
          : problem === "audio_unsupported"
            ? "the sound must be AAC at 44.1 or 48 kHz with at most 2 channels"
            : problem === "no_video_stream"
              ? "the file has no picture"
              : "the duration is unknown";
      return { ok: false, reason: problem, detail };
    }
    return { ok: true, durationSeconds: probe.durationSeconds, bytes: resolved.bytes };
  }

  async function freshFacts(channelId: string, videoIds: readonly string[]): Promise<Map<string, VideoFacts>> {
    const facts = await deps.youtube.readVideoFacts(channelId, videoIds);
    return new Map(facts.map((f) => [f.videoId, f]));
  }

  return {
    async getOverview(channelId: string): Promise<{ stream: StreamView | null; rotation: RotationVideoView[]; sources: Array<{ videoId: string; file: string; setBy: string; setAt: string }> }> {
      const [row, videos, sources] = await Promise.all([deps.store.getStream(channelId), deps.store.listVideos(channelId), deps.store.listSources(channelId)]);
      const rotation = await Promise.all(videos.map(async (v) => toView(v, await deps.channelVideos.titleOf(channelId, v.videoId))));
      return {
        stream: row
          ? {
              channelId,
              intent: row.intent,
              settings: { title: row.title, description: row.description, privacyStatus: row.privacyStatus, madeForKids: row.madeForKids, orderMode: row.orderMode },
              streamId: row.streamId,
              broadcastId: row.broadcastId,
              onSince: row.onSince?.toISOString() ?? null,
            }
          : null,
        rotation,
        sources: sources.map((s) => ({ videoId: s.videoId, file: s.originalPath, setBy: s.setBy, setAt: s.setAt.toISOString() })),
      };
    },

    /** Local only: the texts and order used by the next Start. Editing a running broadcast is its own YouTube write. */
    async saveSettings(channelId: string, input: unknown): Promise<StreamSettingsInput> {
      const settings = parseWithSchema(streamSettingsSchema, input, "live stream settings");
      const now = deps.clock();
      // Only the five settings columns of an existing row (independent review): rewriting the whole row could undo a Start
      // or a YouTube-ended stop that landed between the read and the write.
      const updated = await deps.store.updateStream(channelId, { ...settings, updatedAt: now });
      if (!updated) {
        await deps.store.upsertStream({ channelId, intent: "off", passNumber: 0, positionIndex: 0, positionOffsetSeconds: 0, createdAt: now, ...DEFAULT_SETTINGS, ...settings, updatedAt: now });
      }
      await event(channelId, "settings_saved", { ...settings });
      return settings;
    },

    /**
     * §3.4: adds a video at the end of the rotation. It must be one of the channel's videos, public with no future
     * `publishAt` (read fresh from YouTube), and its original -- the given path, else the Operator's mapped file -- must
     * pass the §3.5 checks. A refusal writes nothing.
     */
    async addVideo(channelId: string, input: unknown): Promise<RotationVideoView> {
      const { videoId, originalPath } = parseWithSchema(addVideoSchema, input, "live stream video");
      const title = await deps.channelVideos.titleOf(channelId, videoId);
      if (title === null) throw refused("not_channel_video", "it is not one of this channel's videos", videoId);
      const videos = await deps.store.listVideos(channelId);
      if (videos.some((v) => v.videoId === videoId)) {
        throw new DomainError({ code: "validation_failed", message: "The video is already in the rotation", details: { videoId } });
      }
      const file = originalPath ?? (await deps.store.listSources(channelId)).find((s) => s.videoId === videoId)?.originalPath;
      if (!file) throw new DomainError({ code: "validation_failed", message: "Choose the video's original file (no file is mapped for it)", details: { videoId } });

      const facts = (await freshFacts(channelId, [videoId])).get(videoId) ?? null;
      const guard = checkPublicOnly(facts, deps.clock());
      if (!guard.allowed) throw refused(guard.reason, `YouTube says it is ${guard.reason}`, videoId);

      const checked = await checkFile(channelId, videoId, file, facts?.durationSeconds ?? null);
      if (!checked.ok) throw refused(checked.reason, checked.detail, videoId);

      const now = deps.clock();
      const row: StoredVideoRow = {
        channelId,
        videoId,
        rotationIndex: videos.reduce((max, v) => Math.max(max, v.rotationIndex + 1), 0),
        originalPath: file,
        videoDurationSeconds: facts?.durationSeconds ?? null,
        originalDurationSeconds: checked.durationSeconds,
        originalBytes: checked.bytes,
        checkStatus: "ok",
        checkReason: null,
        checkedAt: now,
        guardOverrideReason: null,
        guardOverrideAt: null,
        addedAt: now,
      };
      await deps.store.upsertVideo(row);
      await event(channelId, "rotation_add", { videoId, file });
      return toView(row, title);
    },

    async removeVideo(channelId: string, input: unknown): Promise<void> {
      const { videoId } = parseWithSchema(removeVideoSchema, input, "live stream video");
      if (!(await deps.store.deleteVideo(channelId, videoId))) {
        throw new DomainError({ code: "live_stream_video_not_found", message: "The video is not in this channel's rotation", details: { videoId } });
      }
      await event(channelId, "rotation_remove", { videoId });
    },

    /** The new order must name exactly the rotation's videos. Applied at the next pass (or now, with Restart). */
    async reorder(channelId: string, input: unknown): Promise<void> {
      const { videoIds } = parseWithSchema(reorderSchema, input, "live stream order");
      if (!(await deps.store.setOrder(channelId, videoIds))) {
        throw new DomainError({ code: "validation_failed", message: "The order must list exactly the rotation's videos, once each", details: { videoIds } });
      }
      await event(channelId, "rotation_reorder", { videoIds });
    },

    /** §3.4: the owner's explicit override of the public-only guard for one rotation video, with a reason. Audited. */
    async overrideGuard(channelId: string, input: unknown): Promise<void> {
      const { videoId, reason } = parseWithSchema(overrideGuardSchema, input, "guard override");
      const now = deps.clock();
      if (!(await deps.store.updateVideo(channelId, videoId, { guardOverrideReason: reason, guardOverrideAt: now }))) {
        throw new DomainError({ code: "live_stream_video_not_found", message: "The video is not in this channel's rotation", details: { videoId } });
      }
      await event(channelId, "guard_override", { videoId, reason });
    },

    async clearGuardOverride(channelId: string, input: unknown): Promise<void> {
      const { videoId } = parseWithSchema(removeVideoSchema, input, "guard override");
      if (!(await deps.store.updateVideo(channelId, videoId, { guardOverrideReason: null, guardOverrideAt: null }))) {
        throw new DomainError({ code: "live_stream_video_not_found", message: "The video is not in this channel's rotation", details: { videoId } });
      }
      await event(channelId, "guard_override_cleared", { videoId });
    },

    /**
     * §3.4: re-reads every rotation video from YouTube (at every Start and every encoder restart). A video that is no
     * longer public leaves the next pass, unless the owner overrode the guard for it; each change is an event.
     */
    async recheckRotation(channelId: string): Promise<{ playable: string[]; refused: Array<{ videoId: string; reason: VideoRefusal }> }> {
      const videos = await deps.store.listVideos(channelId);
      if (videos.length === 0) return { playable: [], refused: [] };
      const facts = await freshFacts(channelId, videos.map((v) => v.videoId));
      const now = deps.clock();
      const playable: string[] = [];
      const refusedList: Array<{ videoId: string; reason: VideoRefusal }> = [];
      for (const video of videos) {
        const guard = checkPublicOnly(facts.get(video.videoId) ?? null, now);
        if (guard.allowed || video.guardOverrideReason) {
          playable.push(video.videoId);
          await deps.store.updateVideo(channelId, video.videoId, { checkStatus: "ok", checkReason: null, checkedAt: now });
          continue;
        }
        refusedList.push({ videoId: video.videoId, reason: guard.reason });
        const changed = video.checkStatus !== "refused" || video.checkReason !== guard.reason;
        await deps.store.updateVideo(channelId, video.videoId, { checkStatus: "refused", checkReason: guard.reason, checkedAt: now });
        if (changed) await event(channelId, "guard_refused", { videoId: video.videoId, reason: guard.reason });
      }
      return { playable, refused: refusedList };
    },

    /**
     * §3.4: the Operator's map of videos to their original files. Each item is checked (the channel's video, public,
     * the file inside the workspace and within 1 s of the video); accepted ones are stored. The map only offers files;
     * the owner builds the rotation.
     */
    async setSources(channelId: string, input: unknown, setBy: string): Promise<SourceItemResult[]> {
      const { items } = parseWithSchema(sourcesSchema, input, "live stream sources");
      const facts = await freshFacts(channelId, [...new Set(items.map((i) => i.videoId))]);
      const now = deps.clock();
      const results: SourceItemResult[] = [];
      for (const item of items) {
        if ((await deps.channelVideos.titleOf(channelId, item.videoId)) === null) {
          results.push({ ...item, status: "refused", reason: "not_channel_video", detail: "not one of this channel's videos" });
          continue;
        }
        const video = facts.get(item.videoId) ?? null;
        const guard = checkPublicOnly(video, now);
        if (!guard.allowed) {
          results.push({ ...item, status: "refused", reason: guard.reason, detail: `YouTube says it is ${guard.reason}` });
          continue;
        }
        const checked = await checkFile(channelId, item.videoId, item.file, video?.durationSeconds ?? null);
        if (!checked.ok) {
          results.push({ ...item, status: "refused", reason: checked.reason, detail: checked.detail });
          continue;
        }
        await deps.store.upsertSource({ channelId, videoId: item.videoId, originalPath: item.file, setBy, setAt: now });
        results.push({ ...item, status: "accepted" });
      }
      await event(channelId, "sources_set", {
        setBy,
        accepted: results.filter((r) => r.status === "accepted").length,
        refused: results.filter((r) => r.status === "refused").length,
      });
      return results;
    },
  };
}

export type LiveStreamsServices = ReturnType<typeof createLiveStreamsServices>;
