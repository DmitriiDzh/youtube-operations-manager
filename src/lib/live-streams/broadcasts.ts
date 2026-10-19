import { YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { z } from "zod";
import {
  DomainError,
  LIVE_PRIVACY_STATUSES,
  type LiveClosedCaptions,
  type LiveLatency,
  type LivePrivacy,
  type LiveStreamsSettings,
  type LiveVideoSettings,
} from "./contracts";
import { isRecordingRequiredRefusal, isRedundantTransition, liveErrorReason, toLiveDomainError } from "./errors";
import { parseWithSchema } from "./schemas";
import { withChannelLock as withLock } from "./supervisor";
import { applyVideoSettings, describeVideoApply, type VideoApplyResult, type VideoFieldsPort } from "./video-apply";
import { readSegmentSettings } from "./segments";
import { readStoredVideoSettings } from "./video-settings";

// ---------------------------------------------------------------------------
// BL-176 (LIVE_STREAMS_PLAN.md §3.9, ADR 0036 §3) -- the owner's attended actions, the only code that writes to YouTube
// for live streams. Every one: the module on, Live writes on (checked before the first write, so a sequence is not cut in
// half by a refusal), the identity check (`assertWriteChannel`, fails closed), then the write gateway (its adapter calls
// `assertLiveWritesAuthorized` right before each write), an event per write with what was sent and what came back.
// The app never calls these by itself.
// ---------------------------------------------------------------------------

/** §3.9: the broadcast is scheduled this far ahead; with auto-start on it goes live as soon as the picture arrives. */
export const START_LEAD_MS = 2 * 60_000;

type Broadcast = {
  broadcastId: string;
  title: string;
  description: string;
  scheduledStartTime: string | null;
  scheduledEndTime: string | null;
  lifeCycleStatus: string | null;
  privacyStatus: string | null;
  categoryId: string | null;
  /** BL-205: YouTube's own start/end times (the segment switch measures its overlap with them). */
  actualStartTime?: string | null;
  actualEndTime?: string | null;
};

export type BroadcastsDependencies = {
  settings(): Promise<LiveStreamsSettings & { host: { ok: true } | { ok: false; reason: string } }>;
  liveWritesEnabled(): Promise<boolean>;
  auth: { resolve(args: { credentialRef: unknown; requiredScopes: readonly string[] }): Promise<ResolvedCredentials> };
  writeContext: { assertWriteChannel(args: { credentialRef: unknown; credentials: ResolvedCredentials; expectedChannelId: string }): Promise<unknown> };
  streams: {
    get(channelId: string): Promise<{
      channelId: string;
      intent: "on" | "off";
      streamId: string | null;
      broadcastId: string | null;
      title: string;
      description: string;
      privacyStatus: LivePrivacy;
      madeForKids: boolean;
      /** Schema v92 (BL-186): the stream's video and broadcast settings; null = never saved. */
      videoSettingsJson?: string | null;
      /** Schema v99 (BL-205): the segment settings; segments on means every broadcast records. */
      segmentsJson?: string | null;
    } | null>;
    update(channelId: string, set: Record<string, unknown>): Promise<boolean>;
    event(channelId: string, kind: string, detail: Record<string, unknown>): Promise<void>;
  };
  rotation: { recheck(channelId: string): Promise<string[]> };
  youtube: {
    insertStream(credentials: ResolvedCredentials, args: { title: string }): Promise<{ streamId: string }>;
    insertBroadcast(
      credentials: ResolvedCredentials,
      args: {
        title: string;
        description: string;
        scheduledStartTime: string;
        privacyStatus: LivePrivacy;
        selfDeclaredMadeForKids: boolean;
        enableAutoStart: boolean;
        enableAutoStop: boolean;
        enableMonitorStream: boolean;
        recordFromStart: boolean;
        latencyPreference?: LiveLatency;
        enableDvr?: boolean;
        enableEmbed?: boolean;
        closedCaptionsType?: LiveClosedCaptions;
      }
    ): Promise<{ broadcastId: string; lifeCycleStatus: string | null }>;
    bind(credentials: ResolvedCredentials, args: { broadcastId: string; streamId: string }): Promise<{ boundStreamId: string | null }>;
    transition(credentials: ResolvedCredentials, args: { broadcastId: string; broadcastStatus: "live" | "complete" }): Promise<{ lifeCycleStatus: string | null }>;
    update(credentials: ResolvedCredentials, args: { broadcastId: string; snippet: { title: string; description: string; scheduledStartTime: string; scheduledEndTime?: string | null; categoryId?: string | null }; privacyStatus: LivePrivacy }): Promise<void>;
    getBroadcast(credentials: ResolvedCredentials, broadcastId: string): Promise<Broadcast | null>;
    /** BL-186 stage 3: `thumbnails.set` on the broadcast's video (the write gateway). */
    setThumbnail(credentials: ResolvedCredentials, videoId: string, image: { mimeType: "image/jpeg" | "image/png"; bytes: Buffer }): Promise<void>;
    /** BL-186 stage 3: whether a playlist already holds the video (a read; Apply again must not add it twice). */
    playlistHasVideo(credentials: ResolvedCredentials, playlistId: string, videoId: string): Promise<boolean>;
    /** BL-205: `videos.delete` of a segment that never went live. */
    deleteVideo(credentials: ResolvedCredentials, videoId: string): Promise<void>;
  };
  /** BL-186 stage 3: the video-level writers the app layer plugs in (video-details, playlist-management; AGENTS.md §M). */
  videoFields?: VideoFieldsPort;
  /** BL-186 stage 3: the channel's baseline title/description language (owner msg 3153: the broadcast's language is always it). */
  channelLanguage(channelId: string): Promise<string | null>;
  /** BL-186 stage 3: the stream's chosen thumbnail file on this computer. */
  thumbnails: { read(channelId: string): Promise<{ kind: "jpeg" | "png"; bytes: Uint8Array } | null> };
  /** Runs the video settings after Start without holding Start's answer (tests run it in place). */
  background?: (task: () => Promise<unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  supervisor: {
    startEncoder(channelId: string, options: { freshPass: boolean; playable?: readonly string[] }): Promise<{ pid: number }>;
    stopEncoder(channelId: string, reason: string): Promise<boolean>;
  };
  clock: () => Date;
};

export type BroadcastPatch = { title?: string; description?: string; privacyStatus?: LivePrivacy };

// The edit's inputs are checked before anything reaches YouTube (independent review): a title of 1–100 characters (trimmed,
// as YouTube keeps it), a description of at most 5,000, one of the three privacy values; `expected` is what the preview showed.
const patchSchema = z
  .object({ title: z.string().trim().min(1).max(100).optional(), description: z.string().max(5000).optional(), privacyStatus: z.enum(LIVE_PRIVACY_STATUSES).optional() })
  .strict();
const expectedSchema = z.object({ title: z.string(), description: z.string(), privacyStatus: z.string().nullable() }).strict();

export function createLiveBroadcasts(deps: BroadcastsDependencies) {
  async function requireModule(): Promise<void> {
    const settings = await deps.settings();
    if (!settings.enabled || !settings.host.ok) {
      throw new DomainError({ code: "live_streams_host_unsupported", message: settings.host.ok ? "The live-streams module is switched off in Settings" : settings.host.reason });
    }
  }

  /** Live writes on (before any write), then the identity check with write scope. */
  async function authorize(channelId: string, credentialRef: unknown): Promise<ResolvedCredentials> {
    if (!(await deps.liveWritesEnabled())) {
      throw new DomainError({ code: "live_writes_disabled", message: "Live writes are off (Settings). Switch them on to start, stop or edit a broadcast." });
    }
    const credentials = await deps.auth.resolve({ credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] });
    await deps.writeContext.assertWriteChannel({ credentialRef, credentials, expectedChannelId: channelId });
    return credentials;
  }

  async function requireStream(channelId: string) {
    const stream = await deps.streams.get(channelId);
    if (!stream || !stream.title.trim()) {
      throw new DomainError({ code: "validation_failed", message: "Save the stream's title first", details: { channelId } });
    }
    return stream;
  }

  /**
   * BL-186: the stream's saved video settings. A stored value that does not pass the schema refuses Start before any write
   * (fail closed: never a silent fallback to defaults the owner did not choose).
   */
  function savedVideoSettings(stream: { videoSettingsJson?: string | null }): LiveVideoSettings | null {
    const stored = readStoredVideoSettings(stream.videoSettingsJson);
    if (!stored.ok) throw new DomainError({ code: "validation_failed", message: `${stored.problem}. Save the stream's video settings again.` });
    return stored.settings;
  }

  async function written(channelId: string, method: string, detail: Record<string, unknown>) {
    await deps.streams.event(channelId, "youtube_write", { method, ...detail });
  }

  /** BL-186 stage 3: the broadcast's video settings, one channel at a time. */
  function runVideoSettings(args: { channelId: string; broadcastId: string; credentialRef: unknown; credentials: ResolvedCredentials; settings: LiveVideoSettings; trigger: "start" | "again" | "segment" }): Promise<VideoApplyResult> {
    return withLock(`video-settings:${args.channelId}`, async () => {
      try {
        const channelLanguage = await deps.channelLanguage(args.channelId);
        return await applyVideoSettings(
          {
            videoFields: deps.videoFields,
            youtube: deps.youtube,
            thumbnails: deps.thumbnails,
            event: (channelId, kind, detail) => deps.streams.event(channelId, kind, detail),
            sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
            isCurrent: async (channelId, broadcastId) => {
              const stream = await deps.streams.get(channelId);
              if (stream?.intent !== "on") return "stopped";
              // BL-205: a segment switch replaced the broadcast -- the new segment gets its own application.
              return stream.broadcastId === broadcastId ? "current" : "replaced";
            },
          },
          { ...args, channelLanguage }
        );
      } catch (error) {
        // Never a silent end (review): the page reads this summary, so a run that threw still leaves one.
        const result: VideoApplyResult = { broadcastId: args.broadcastId, ok: false, steps: [{ step: "run", ok: false, error: error instanceof Error ? error.message : String(error) }] };
        await deps.streams.event(args.channelId, "video_settings_applied", { ...result, trigger: args.trigger }).catch(() => undefined);
        return result;
      }
    });
  }

  /** One Start at a time per channel: a second request waits, then finds the stream on and is refused. */
  async function startOnce(channelId: string, credentialRef: unknown): Promise<{ broadcastId: string; streamId: string; encoderStarted: boolean; encoderError?: string; recordingForced?: boolean; videoSettings: "applying" | "not_saved" }> {
    await requireModule();
    const stream = await requireStream(channelId);
    // A second Start (a stale page, a repeated request) must not create another broadcast and lose track of the live one.
    if (stream.intent === "on") throw new DomainError({ code: "validation_failed", message: "The stream is already on: stop it first", details: { channelId } });
    const videoSettings = savedVideoSettings(stream);
    const credentials = await authorize(channelId, credentialRef);
    const playable = await deps.rotation.recheck(channelId);
    if (playable.length === 0) {
      throw new DomainError({ code: "live_stream_video_refused", message: "No video in the rotation can be streamed (public, with its file)", details: { channelId, reason: "empty" } });
    }

    let streamId = stream.streamId;
    try {
      if (!streamId) {
        ({ streamId } = await deps.youtube.insertStream(credentials, { title: stream.title }));
        await deps.streams.update(channelId, { streamId });
        await written(channelId, "liveStreams.insert", { streamId });
      }
      let sent = {
        title: stream.title,
        description: stream.description,
        scheduledStartTime: new Date(deps.clock().getTime() + START_LEAD_MS).toISOString(),
        privacyStatus: stream.privacyStatus,
        selfDeclaredMadeForKids: stream.madeForKids,
        enableAutoStart: true,
        enableAutoStop: false,
        enableMonitorStream: false,
        // BL-205: with segments on, the broadcast records (keeping the recordings is the point of segments).
        recordFromStart: readSegmentSettings(stream.segmentsJson).enabled,
        // BL-186: the owner's broadcast settings, set at insert (DVR and captions cannot change once live). Never saved: not sent.
        ...(videoSettings ? videoSettings.broadcast : {}),
      };
      // Spike C (2026-10-19): a channel that may not switch recording off is refused the broadcast. The stream still starts --
      // once more with recording on -- and Start says so; nothing is created by the refused insert.
      let recordingForced = false;
      let inserted: { broadcastId: string; lifeCycleStatus: string | null };
      try {
        inserted = await deps.youtube.insertBroadcast(credentials, sent);
      } catch (error) {
        if (!isRecordingRequiredRefusal(error)) throw error;
        await deps.streams.event(channelId, "recording_required", { message: error instanceof Error ? error.message : String(error) });
        sent = { ...sent, recordFromStart: true };
        recordingForced = true;
        inserted = await deps.youtube.insertBroadcast(credentials, sent);
      }
      const { broadcastId, lifeCycleStatus } = inserted;
      await written(channelId, "liveBroadcasts.insert", { broadcastId, sent, lifeCycleStatus });
      let bound: { boundStreamId: string | null };
      try {
        bound = await deps.youtube.bind(credentials, { broadcastId, streamId });
      } catch (error) {
        // The channel's stream was deleted in Studio: forget it, so the next Start creates a new one (independent review).
        if (liveErrorReason(error) === "liveStreamNotFound") {
          await deps.streams.update(channelId, { streamId: null });
          await deps.streams.event(channelId, "stream_forgotten", { streamId, broadcastId, reason: "liveStreamNotFound" });
          throw new DomainError({
            code: "update_failed",
            message: "YouTube no longer has this channel's stream (deleted in Studio?). It is forgotten: press Start again to create a new one.",
            details: { action: "Start", reason: "liveStreamNotFound", orphanBroadcastId: broadcastId },
          });
        }
        throw error;
      }
      await written(channelId, "liveBroadcasts.bind", { broadcastId, streamId, boundStreamId: bound.boundStreamId });
      // The broadcast is recorded only once it is bound: a failed Start never leaves the app tracking a broadcast with no stream.
      await deps.streams.update(channelId, { broadcastId, intent: "on", onSince: deps.clock() });

      // BL-186 stage 3: the saved video settings go to the broadcast's video after the encoder start, in the background, so Start
      // answers at once; each step is an event and a failure never ends the broadcast (plan §2.2 step 4).
      const videoSettingsState = videoSettings ? "applying" : "not_saved";
      const scheduleVideoSettings = () => {
        if (!videoSettings) return;
        const task = () => runVideoSettings({ channelId, broadcastId, credentialRef, credentials, settings: videoSettings, trigger: "start" });
        (deps.background ?? ((run) => void run().catch(() => undefined)))(task);
      };
      try {
        await deps.supervisor.startEncoder(channelId, { freshPass: true, playable });
        scheduleVideoSettings();
        return { broadcastId, streamId, encoderStarted: true, videoSettings: videoSettingsState, ...(recordingForced ? { recordingForced } : {}) };
      } catch (error) {
        // The broadcast exists and is bound; the intent is on, so the background loop keeps trying to start the encoder.
        const message = error instanceof Error ? error.message : String(error);
        await deps.streams.event(channelId, "encoder_start_failed", { message });
        scheduleVideoSettings();
        return { broadcastId, streamId, encoderStarted: false, encoderError: message, videoSettings: videoSettingsState, ...(recordingForced ? { recordingForced } : {}) };
      }
    } catch (error) {
      throw toLiveDomainError(error, "Start");
    }
  }

  return {
    /**
     * §3.9 the Start dialog (the dry run): exactly what Start will send, and its quota units -- 5 the first time
     * (`liveStreams.insert`, `videos.list`, `liveBroadcasts.insert`, `bind`, `liveStreams.list`), 4 after. No YouTube call.
     */
    async previewStart(channelId: string) {
      const stream = await requireStream(channelId);
      const settings = await deps.settings();
      const stored = readStoredVideoSettings(stream.videoSettingsJson);
      const videoSettings = stored.ok ? stored.settings : null;
      const apply = videoSettings && deps.videoFields ? describeVideoApply(videoSettings, await deps.channelLanguage(channelId)) : null;
      return {
        createsStream: !stream.streamId,
        broadcast: {
          title: stream.title,
          description: stream.description,
          privacyStatus: stream.privacyStatus,
          madeForKids: stream.madeForKids,
          enableAutoStart: true,
          enableAutoStop: false,
          enableMonitorStream: false,
          recordFromStart: false,
          // BL-186: sent with the insert (no extra units); null = never saved, YouTube's defaults apply.
          settings: videoSettings ? videoSettings.broadcast : null,
        },
        /**
         * BL-186: the saved video-level settings (tags, category, languages, thumbnail, playlists...). Stage 3: sent to the
         * broadcast's video right after the encoder starts (`videoSettingsApply`: exactly what, and its units).
         */
        videoSettings: videoSettings ? { ...videoSettings, broadcast: undefined } : null,
        videoSettingsApply: apply,
        videoSettingsProblem: stored.ok ? null : stored.problem,
        units: (stream.streamId ? 4 : 5) + (apply?.units ?? 0),
        liveWritesEnabled: await deps.liveWritesEnabled(),
        moduleReady: settings.enabled && settings.host.ok,
      };
    },

    /** §3.9 Start: create the stream (first time), a broadcast, bind them, then start the encoder. */
    start: (channelId: string, credentialRef: unknown) => withLock(`start:${channelId}`, () => startOnce(channelId, credentialRef)),

    /** BL-205: the saved video settings for a new segment the switcher just made live (in the background, like after Start). */
    applyVideoSettingsForSegment(args: { channelId: string; broadcastId: string; credentialRef: unknown; credentials: ResolvedCredentials }): void {
      void (async () => {
        const stream = await deps.streams.get(args.channelId);
        const stored = readStoredVideoSettings(stream?.videoSettingsJson);
        if (!stored.ok || !stored.settings) return;
        const settings = stored.settings;
        const task = () => runVideoSettings({ ...args, settings, trigger: "segment" });
        (deps.background ?? ((run) => void run().catch(() => undefined)))(task);
      })().catch(() => undefined);
    },

    /** BL-186 stage 3, «Применить снова», step 1 (the dry run): what would be sent to the running broadcast's video now. No call. */
    async previewApplyVideoSettings(channelId: string) {
      const stream = await deps.streams.get(channelId);
      if (!stream?.broadcastId || stream.intent !== "on") throw new DomainError({ code: "validation_failed", message: "The stream is not on: there is no broadcast to apply the settings to", details: { channelId } });
      const settings = savedVideoSettings(stream);
      if (!settings) throw new DomainError({ code: "validation_failed", message: "Save the stream's video settings first", details: { channelId } });
      if (!deps.videoFields) throw new DomainError({ code: "validation_failed", message: "Video settings cannot be applied here (the video details module is not available)", details: { channelId } });
      return { broadcastId: stream.broadcastId, ...describeVideoApply(settings, await deps.channelLanguage(channelId)), liveWritesEnabled: await deps.liveWritesEnabled() };
    },

    /** BL-186 stage 3, «Применить снова»: the saved video settings, sent again to the running broadcast's video (the owner's action). */
    async applyVideoSettingsAgain(channelId: string, credentialRef: unknown): Promise<VideoApplyResult> {
      await requireModule();
      const stream = await deps.streams.get(channelId);
      if (!stream?.broadcastId || stream.intent !== "on") throw new DomainError({ code: "validation_failed", message: "The stream is not on: there is no broadcast to apply the settings to", details: { channelId } });
      const settings = savedVideoSettings(stream);
      if (!settings) throw new DomainError({ code: "validation_failed", message: "Save the stream's video settings first", details: { channelId } });
      if (!deps.videoFields) throw new DomainError({ code: "validation_failed", message: "Video settings cannot be applied here (the video details module is not available)", details: { channelId } });
      const credentials = await authorize(channelId, credentialRef);
      return runVideoSettings({ channelId, broadcastId: stream.broadcastId, credentialRef, credentials, settings, trigger: "again" });
    },

    /** §3.9: if the picture arrives but the broadcast is not live after a few minutes, the owner asks for `live`. */
    async goLive(channelId: string, credentialRef: unknown): Promise<{ lifeCycleStatus: string | null }> {
      await requireModule();
      const stream = await deps.streams.get(channelId);
      if (!stream?.broadcastId) throw new DomainError({ code: "validation_failed", message: "There is no broadcast to make live", details: { channelId } });
      const credentials = await authorize(channelId, credentialRef);
      try {
        const result = await deps.youtube.transition(credentials, { broadcastId: stream.broadcastId, broadcastStatus: "live" });
        await written(channelId, "liveBroadcasts.transition", { broadcastId: stream.broadcastId, broadcastStatus: "live", lifeCycleStatus: result.lifeCycleStatus });
        return result;
      } catch (error) {
        if (isRedundantTransition(error)) return { lifeCycleStatus: "live" };
        throw toLiveDomainError(error, "Go live");
      }
    },

    /**
     * §3.9 Stop: end the broadcast on YouTube (`transition complete`), then stop the encoder and turn the intent off.
     * `encoderOnly` (offered when Live writes are off) stops only the encoder: the broadcast stays open on YouTube
     * without a picture until it is ended there.
     */
    async stop(channelId: string, credentialRef: unknown, options: { encoderOnly: boolean }): Promise<{ broadcastEnded: boolean; youtubeRefusal?: string }> {
      const stream = await deps.streams.get(channelId);
      if (!stream) throw new DomainError({ code: "validation_failed", message: "There is no stream", details: { channelId } });
      let broadcastEnded = false;
      let youtubeRefusal: string | null = null;
      if (!options.encoderOnly && stream.broadcastId) {
        const credentials = await authorize(channelId, credentialRef);
        try {
          const result = await deps.youtube.transition(credentials, { broadcastId: stream.broadcastId, broadcastStatus: "complete" });
          await written(channelId, "liveBroadcasts.transition", { broadcastId: stream.broadcastId, broadcastStatus: "complete", lifeCycleStatus: result.lifeCycleStatus });
          broadcastEnded = true;
        } catch (error) {
          const reason = liveErrorReason(error);
          if (isRedundantTransition(error)) {
            broadcastEnded = true;
          } else if (reason === "liveBroadcastNotFound" || reason === "invalidTransition") {
            // YouTube has no broadcast to end (deleted in Studio) or it never went live: stop sending anyway (independent review).
            youtubeRefusal = reason;
          } else {
            throw toLiveDomainError(error, "Stop");
          }
        }
      }
      // The intent goes off first, so the background loop cannot start a new encoder between the two (verification review).
      await deps.streams.update(channelId, { intent: "off", onSince: null });
      await deps.supervisor.stopEncoder(channelId, options.encoderOnly ? "owner_encoder_only" : "owner_stop");
      await deps.streams.event(channelId, "stopped_by_owner", { encoderOnly: options.encoderOnly, broadcastEnded, ...(youtubeRefusal ? { youtubeRefusal } : {}) });
      return { broadcastEnded, ...(youtubeRefusal ? { youtubeRefusal } : {}) };
    },

    /** §3.9 Edit, step 1: the broadcast as YouTube has it now, and what it would become. A read. */
    async previewEdit(channelId: string, credentialRef: unknown, rawPatch: unknown) {
      const patch: BroadcastPatch = parseWithSchema(patchSchema, rawPatch ?? {}, "broadcast edit");
      const stream = await deps.streams.get(channelId);
      if (!stream?.broadcastId) throw new DomainError({ code: "validation_failed", message: "There is no broadcast to edit", details: { channelId } });
      const credentials = await deps.auth.resolve({ credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] });
      const before = await deps.youtube.getBroadcast(credentials, stream.broadcastId);
      if (!before) throw new DomainError({ code: "not_found", message: "YouTube no longer has this broadcast", details: { channelId } });
      const current = { title: before.title, description: before.description, privacyStatus: before.privacyStatus as LivePrivacy };
      return { before: current, after: { ...current, ...patch } };
    },

    /**
     * §3.9 Edit, steps 2–4: refused if the broadcast changed on YouTube since the preview (`expected`); the update sends
     * the full merged snippet (the parts sent are replaced wholesale) and is read back. The event holds both versions:
     * that is the backup.
     */
    async edit(channelId: string, credentialRef: unknown, rawPatch: unknown, rawExpected: unknown) {
      const patch: BroadcastPatch = parseWithSchema(patchSchema, rawPatch ?? {}, "broadcast edit");
      const expected = parseWithSchema(expectedSchema, rawExpected, "broadcast edit (what the preview showed)");
      await requireModule();
      const stream = await deps.streams.get(channelId);
      if (!stream?.broadcastId) throw new DomainError({ code: "validation_failed", message: "There is no broadcast to edit", details: { channelId } });
      const credentials = await authorize(channelId, credentialRef);
      const before = await deps.youtube.getBroadcast(credentials, stream.broadcastId);
      if (!before) throw new DomainError({ code: "not_found", message: "YouTube no longer has this broadcast", details: { channelId } });
      if (before.title !== expected.title || before.description !== expected.description || before.privacyStatus !== expected.privacyStatus) {
        throw new DomainError({ code: "validation_failed", message: "The broadcast changed on YouTube since the preview -- preview again before saving", details: { channelId, before } });
      }
      if (!before.scheduledStartTime) throw new DomainError({ code: "update_failed", message: "YouTube returned no start time for the broadcast", details: { channelId } });
      const after = { title: patch.title ?? before.title, description: patch.description ?? before.description, privacyStatus: (patch.privacyStatus ?? before.privacyStatus) as LivePrivacy };
      try {
        await deps.youtube.update(credentials, {
          broadcastId: stream.broadcastId,
          snippet: { title: after.title, description: after.description, scheduledStartTime: before.scheduledStartTime, scheduledEndTime: before.scheduledEndTime, categoryId: before.categoryId },
          privacyStatus: after.privacyStatus,
        });
      } catch (error) {
        throw toLiveDomainError(error, "Edit");
      }
      const readBack = await deps.youtube.getBroadcast(credentials, stream.broadcastId);
      const verified = !!readBack && readBack.title === after.title && readBack.description === after.description && readBack.privacyStatus === after.privacyStatus;
      await written(channelId, "liveBroadcasts.update", {
        broadcastId: stream.broadcastId,
        before: { title: before.title, description: before.description, privacyStatus: before.privacyStatus },
        after,
        verified,
      });
      await deps.streams.update(channelId, { title: after.title, description: after.description, privacyStatus: after.privacyStatus });
      if (!verified) throw new DomainError({ code: "update_failed", message: "YouTube accepted the change but reads back something else", details: { channelId, readBack } });
      return { before, after, verified };
    },
  };
}

export type LiveBroadcasts = ReturnType<typeof createLiveBroadcasts>;
