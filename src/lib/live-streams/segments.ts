import { z } from "zod";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import type { LiveVideoSettings } from "./fields";

// ---------------------------------------------------------------------------
// BL-205 (FO-REQ-0032, docs/roadmap/plans/LIVE_SEGMENTS_PLAN.md): a 24/7 stream as a chain of broadcasts ("segments") under 12 h,
// so YouTube keeps each recording. The switch runs on the same reusable stream and the same encoder (spike D: bind while live,
// both live for a moment, then the old one ends -- no gap). The new segment is made live first; the old one is ended only after
// that. A switch that fails never ends the old one. Every write goes through the gateway (via the deps), after Live writes and
// the identity check; the switches are the app's own writes (ADR 0044), allowed only while the owner's «Перезапуск эфира» is on.
// ---------------------------------------------------------------------------

import { SEGMENT_DEFAULT_MINUTES, SEGMENT_MAX_MINUTES, SEGMENT_MIN_MINUTES } from "./fields";
export { SEGMENT_DEFAULT_MINUTES, SEGMENT_MAX_MINUTES, SEGMENT_MIN_MINUTES };
/** A quiet hour moves a switch that is due within this window of it. */
export const QUIET_HOUR_WINDOW_MS = 2 * 3_600_000;
/** How long the new segment may take to go live before the switch is given up. */
export const GO_LIVE_TIMEOUT_MS = 5 * 60_000;
/** After a failed switch, the next attempt is not before this. */
export const SWITCH_RETRY_MS = 30 * 60_000;
/** Switches per channel per UTC day, successes and failures together. */
export const DAILY_SWITCH_CAP = 6;
/** The recording goes into the playlist after the switch; a refusal is retried this often, this many times (2 h). */
export const PLAYLIST_RETRY_MS = 10 * 60_000;
export const PLAYLIST_MAX_ATTEMPTS = 12;

export const segmentSettingsSchema = z
  .object({
    v: z.literal(1),
    enabled: z.boolean(),
    lengthMinutes: z.number().int().min(SEGMENT_MIN_MINUTES).max(SEGMENT_MAX_MINUTES),
    switchHourUtc: z.number().int().min(0).max(23).nullable(),
    recordingsPlaylist: z.object({ id: z.string().min(1).max(64), title: z.string().max(150) }).nullable(),
  })
  .strict();
export type SegmentSettings = z.infer<typeof segmentSettingsSchema>;
export const DEFAULT_SEGMENT_SETTINGS: SegmentSettings = Object.freeze({ v: 1, enabled: false, lengthMinutes: SEGMENT_DEFAULT_MINUTES, switchHourUtc: null, recordingsPlaylist: null }) as SegmentSettings;

/** The stored settings, or the defaults (off) when never saved or unreadable -- an unreadable value never switches anything. */
export function readSegmentSettings(json: string | null | undefined): SegmentSettings {
  if (!json) return DEFAULT_SEGMENT_SETTINGS;
  try {
    const parsed = segmentSettingsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : DEFAULT_SEGMENT_SETTINGS;
  } catch {
    return DEFAULT_SEGMENT_SETTINGS;
  }
}

/**
 * When the segment that started at `startedAt` should switch. Its own length, unless a quiet hour (UTC) falls within 2 h of that
 * time -- then at the quiet hour, but only while the segment stays within 705 min (never past 12 h, plan §2.1).
 */
export function switchDueAt(settings: SegmentSettings, startedAt: number): number {
  const due = startedAt + settings.lengthMinutes * 60_000;
  if (settings.switchHourUtc === null) return due;
  const limit = startedAt + SEGMENT_MAX_MINUTES * 60_000;
  const candidates: number[] = [];
  const dayStart = Date.UTC(new Date(due).getUTCFullYear(), new Date(due).getUTCMonth(), new Date(due).getUTCDate());
  for (const offsetDays of [-1, 0, 1]) candidates.push(dayStart + offsetDays * 86_400_000 + settings.switchHourUtc * 3_600_000);
  const quiet = candidates
    .filter((at) => Math.abs(at - due) <= QUIET_HOUR_WINDOW_MS && at > startedAt + SEGMENT_MIN_MINUTES * 60_000 && at <= limit)
    .sort((a, b) => Math.abs(a - due) - Math.abs(b - due))[0];
  return quiet ?? due;
}

export function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * The switch as a persisted state machine (independent review): every step is written to the stream's marker BEFORE it is
 * acted on, each tick advances it by one short step (no long waits inside a tick), and a crash or restart simply resumes it.
 * - `going_live`: the new broadcast is inserted, bound and asked to go live; ticks read its state until it is live.
 * - `handover`: the stream row names the new broadcast; ticks end the old one until YouTube says it ended.
 * - `cleanup`: the switch failed or the stream was stopped; ticks end or delete the new one until done.
 */
export type SwitchMarker = {
  phase: "going_live" | "handover" | "cleanup";
  startedAt: number;
  fromBroadcastId: string;
  newBroadcastId: string;
  /** When `transition live` was last sent (sent once, and once more if still not starting after a minute). */
  liveRequestedAt: number;
  liveRequests: number;
  /** `cleanup`: why the switch is given up (the failure stage, or `stream_stopped`). */
  reason?: string;
  attempts?: number;
  lastAttemptAt?: number;
};

/** Ending the old segment, or cleaning up the new one, is retried after this, doubling each time up to an hour (quota: review). */
export const STEP_RETRY_MS = 60_000;
export const STEP_RETRY_MAX_MS = 3_600_000;
export function stepRetryDelay(attempts: number): number {
  return Math.min(STEP_RETRY_MS * 2 ** Math.max(0, attempts - 1), STEP_RETRY_MAX_MS);
}
/** A broadcast that is not live yet is read again only after this (no row until it is live). */
export const NOT_LIVE_RECHECK_MS = 5 * 60_000;
/** After this many attempts to end the old segment, the owner is told (the switcher keeps trying: two live broadcasts must end). */
export const HANDOVER_ALERT_ATTEMPTS = 5;
/** `transition live` is repeated once if the broadcast has not started after this long. */
export const LIVE_REQUEST_REPEAT_MS = 60_000;

type Lifecycle = { lifeCycleStatus: string | null; actualStartTime: string | null; actualEndTime: string | null; recordFromStart?: boolean | null };

type StreamRow = {
  channelId: string;
  intent: "on" | "off";
  streamId: string | null;
  broadcastId: string | null;
  onSince: Date | null;
  title: string;
  description: string;
  privacyStatus: "public" | "unlisted" | "private";
  madeForKids: boolean;
  segmentsJson?: string | null;
  segmentSwitchingJson?: string | null;
};

type SegmentRow = {
  id: string;
  broadcastId: string;
  startedAt: Date;
  endedAt: Date | null;
  recorded: boolean;
  playlistStatus: "none" | "pending" | "added" | "failed";
  playlistAttempts: number;
};

export type SegmentsDependencies = {
  streams: {
    get(channelId: string): Promise<StreamRow | null>;
    update(channelId: string, set: Record<string, unknown>): Promise<unknown>;
    event(channelId: string, kind: string, detail: Record<string, unknown>): Promise<void>;
    countEventsSince(channelId: string, kinds: readonly string[], since: Date): Promise<number>;
  };
  segments: {
    insert(row: { id: string; channelId: string; broadcastId: string; startedAt: Date; recorded: boolean; recordingStatus: "none"; playlistStatus: "none"; playlistAttempts: 0 }): Promise<void>;
    update(id: string, set: Record<string, unknown>): Promise<void>;
    /** Every segment of the channel that has no end yet, or whose recording still waits for the playlist. */
    open(channelId: string): Promise<SegmentRow[]>;
  };
  /** The broadcast settings saved with the stream (latency, DVR, embedding, captions), when any. */
  broadcastSettings(channelId: string): Promise<LiveVideoSettings["broadcast"] | null>;
  /** The channel's connected account, Live writes and the identity check (fails closed: throws). */
  authorize(channelId: string): Promise<{ credentialRef: unknown; credentials: ResolvedCredentials }>;
  youtube: {
    insertBroadcast(credentials: ResolvedCredentials, args: {
      title: string;
      description: string;
      scheduledStartTime: string;
      privacyStatus: "public" | "unlisted" | "private";
      selfDeclaredMadeForKids: boolean;
      enableAutoStart: boolean;
      enableAutoStop: boolean;
      enableMonitorStream: boolean;
      recordFromStart: boolean;
    } & Partial<LiveVideoSettings["broadcast"]>): Promise<{ broadcastId: string }>;
    bind(credentials: ResolvedCredentials, args: { broadcastId: string; streamId: string }): Promise<unknown>;
    /** `live` or `complete`; a "redundant transition" (already there) resolves, it is not an error. */
    transition(credentials: ResolvedCredentials, args: { broadcastId: string; broadcastStatus: "live" | "complete" }): Promise<unknown>;
    /** The broadcasts' states and YouTube's own start/end times (and whether they record); one YouTube no longer has is absent. */
    lifecycles(credentials: ResolvedCredentials, broadcastIds: string[]): Promise<Record<string, Lifecycle>>;
    deleteVideo(credentials: ResolvedCredentials, videoId: string): Promise<void>;
  };
  /** BL-186 stage 3: the saved video settings for the new segment (in the background). */
  applyVideoSettings(args: { channelId: string; broadcastId: string; credentialRef: unknown; credentials: ResolvedCredentials }): void;
  /** playlist-management's add, plugged in by the app layer; absent = recordings are not added to playlists. */
  addToPlaylist?(args: { credentialRef: unknown; channelId: string; playlistId: string; videoId: string }): Promise<{ added: boolean; reason?: string }>;
  /** The rotation videos the encoder played in the segment, best effort. */
  playedVideos(channelId: string): Promise<string[]>;
  /** The lock the owner's Stop, Go live and Edit take for this channel: a switch step never runs at the same time as them. Busy ->
   * the step is skipped (resolves undefined), never waited for. */
  withBroadcastLock(channelId: string, fn: () => Promise<void>): Promise<void | undefined>;
  newId(): string;
  clock(): number;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readSwitchMarker(json: string | null | undefined): SwitchMarker | null {
  if (!json) return null;
  try {
    const marker = JSON.parse(json) as SwitchMarker;
    return marker && typeof marker.newBroadcastId === "string" && typeof marker.fromBroadcastId === "string" ? marker : null;
  } catch {
    return null;
  }
}

export function createLiveSegments(deps: SegmentsDependencies) {
  /** A failed switch's earliest retry, per channel (in memory; the daily cap in the database bounds a restart loop). */
  const retryAt = new Map<string, number>();
  const capNotified = new Set<string>();
  const notLiveUntil = new Map<string, number>();

  async function writeMarker(channelId: string, marker: SwitchMarker | null) {
    await deps.streams.update(channelId, { segmentSwitchingJson: marker ? JSON.stringify(marker) : null });
  }

  const isoTime = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);

  /**
   * The row of the running broadcast, created from YouTube's own start time and recording flag when missing (the owner's Start,
   * or a broadcast started before segments were on). Rows of broadcasts that are no longer the stream's are closed.
   */
  async function currentSegment(stream: StreamRow): Promise<SegmentRow | null> {
    const open = await deps.segments.open(stream.channelId);
    const settings = readSegmentSettings(stream.segmentsJson);
    for (const row of open) {
      if (row.endedAt === null && row.broadcastId !== stream.broadcastId) {
        // A broadcast the owner's Stop (or YouTube) ended: closed; its recording still goes to the playlist when it recorded.
        const pending = row.recorded && settings.recordingsPlaylist !== null && deps.addToPlaylist !== undefined;
        await deps.segments.update(row.id, { endedAt: new Date(deps.clock()), recordingStatus: row.recorded ? "recorded" : "none", playlistStatus: pending ? "pending" : "none" });
      }
    }
    const found = open.find((s) => s.broadcastId === stream.broadcastId && s.endedAt === null);
    if (found) return found;
    if (deps.clock() < (notLiveUntil.get(stream.channelId) ?? 0)) return null;
    const { credentials } = await deps.authorize(stream.channelId);
    const life = (await deps.youtube.lifecycles(credentials, [stream.broadcastId!]))[stream.broadcastId!];
    if (!life || life.lifeCycleStatus !== "live") {
      notLiveUntil.set(stream.channelId, deps.clock() + NOT_LIVE_RECHECK_MS); // not live yet: no segment to time
      return null;
    }
    notLiveUntil.delete(stream.channelId);
    const row = {
      id: deps.newId(),
      channelId: stream.channelId,
      broadcastId: stream.broadcastId!,
      startedAt: new Date(isoTime(life.actualStartTime) ?? stream.onSince?.getTime() ?? deps.clock()),
      recorded: life.recordFromStart === true,
      recordingStatus: "none" as const,
      playlistStatus: "none" as const,
      playlistAttempts: 0 as const,
    };
    await deps.segments.insert(row);
    return { ...row, endedAt: null };
  }

  /** Starts a switch: insert, bind, ask once to go live. Each id is in the marker before the next call. */
  async function begin(stream: StreamRow, auth: { credentials: ResolvedCredentials }): Promise<void> {
    const { channelId } = stream;
    const from = stream.broadcastId!;
    let to: string;
    try {
      const broadcast = await deps.broadcastSettings(channelId);
      ({ broadcastId: to } = await deps.youtube.insertBroadcast(auth.credentials, {
        title: stream.title,
        description: stream.description,
        scheduledStartTime: new Date(deps.clock() + 60_000).toISOString(),
        privacyStatus: stream.privacyStatus,
        selfDeclaredMadeForKids: stream.madeForKids,
        enableAutoStart: false,
        enableAutoStop: false,
        enableMonitorStream: false,
        recordFromStart: true,
        ...(broadcast ?? {}),
      }));
    } catch (error) {
      // Nothing was created: the switch simply failed (the old segment goes on).
      retryAt.set(channelId, deps.clock() + SWITCH_RETRY_MS);
      await deps.streams.event(channelId, "live_segment_switch_failed", { stage: "insert", message: messageOf(error), newBroadcastId: null });
      return;
    }
    const marker: SwitchMarker = { phase: "going_live", startedAt: deps.clock(), fromBroadcastId: from, newBroadcastId: to, liveRequestedAt: 0, liveRequests: 0 };
    await writeMarker(channelId, marker);
    await deps.streams.event(channelId, "youtube_write", { method: "liveBroadcasts.insert", broadcastId: to, segment: true });
    try {
      await deps.youtube.bind(auth.credentials, { broadcastId: to, streamId: stream.streamId! });
      await deps.streams.event(channelId, "youtube_write", { method: "liveBroadcasts.bind", broadcastId: to, streamId: stream.streamId, segment: true });
    } catch (error) {
      await writeMarker(channelId, { ...marker, phase: "cleanup", reason: "bind", attempts: 0 });
      await deps.streams.event(channelId, "live_segment_switch_failed", { stage: "bind", message: messageOf(error), newBroadcastId: to });
      return;
    }
    await requestLive(channelId, marker, auth.credentials);
  }

  async function requestLive(channelId: string, marker: SwitchMarker, credentials: ResolvedCredentials) {
    try {
      await deps.youtube.transition(credentials, { broadcastId: marker.newBroadcastId, broadcastStatus: "live" });
    } catch {
      // The state read decides: a refusal here is either "already starting" or a real problem the 5-minute limit catches.
    }
    await writeMarker(channelId, { ...marker, liveRequestedAt: deps.clock(), liveRequests: marker.liveRequests + 1 });
  }

  /** `going_live`: read the new broadcast; live -> hand over; too slow -> give up (cleanup). Reads only, except one repeat. */
  async function stepGoingLive(stream: StreamRow, marker: SwitchMarker, credentials: ResolvedCredentials): Promise<void> {
    const { channelId } = stream;
    const life = (await deps.youtube.lifecycles(credentials, [marker.newBroadcastId]))[marker.newBroadcastId];
    if (life?.lifeCycleStatus === "live") {
      if (stream.intent !== "on" || stream.broadcastId !== marker.fromBroadcastId) {
        await writeMarker(channelId, { ...marker, phase: "cleanup", reason: "stream_stopped", attempts: 0 });
        return;
      }
      // Hand over: the stream row names the new segment BEFORE the old one ends, so the broadcast check never takes the old
      // segment's end for the stream's end (plan §2.2 step 5).
      await writeMarker(channelId, { ...marker, phase: "handover", attempts: 0 });
      await deps.streams.update(channelId, { broadcastId: marker.newBroadcastId });
      return;
    }
    if (deps.clock() - marker.startedAt >= GO_LIVE_TIMEOUT_MS) {
      await writeMarker(channelId, { ...marker, phase: "cleanup", reason: "go_live", attempts: 0 });
      await deps.streams.event(channelId, "live_segment_switch_failed", { stage: "go_live", message: `the new segment did not go live within 5 minutes (state ${life?.lifeCycleStatus ?? "gone"})`, newBroadcastId: marker.newBroadcastId });
      return;
    }
    const waiting = !life || life.lifeCycleStatus === "ready" || life.lifeCycleStatus === "testing" || life.lifeCycleStatus === "created";
    if (waiting && marker.liveRequests < 2 && deps.clock() - marker.liveRequestedAt >= LIVE_REQUEST_REPEAT_MS) await requestLive(channelId, marker, credentials);
  }

  /** `handover`: end the old segment until YouTube says it ended; then close the rows and finish. Never gives up. */
  async function stepHandover(stream: StreamRow, marker: SwitchMarker, auth: { credentialRef: unknown; credentials: ResolvedCredentials }, settings: SegmentSettings): Promise<void> {
    const { channelId } = stream;
    const attempts = marker.attempts ?? 0;
    // Stopped, or stopped and started again (the row names a third broadcast): nothing is handed over.
    const stopped = stream.intent !== "on" || (stream.broadcastId !== marker.fromBroadcastId && stream.broadcastId !== marker.newBroadcastId);
    // A crash between writing this phase and moving the row (review): the row is moved first, so the old segment's end is never
    // taken for the stream's end.
    if (!stopped && stream.broadcastId === marker.fromBroadcastId) await deps.streams.update(channelId, { broadcastId: marker.newBroadcastId });
    let ended = false;
    try {
      await deps.youtube.transition(auth.credentials, { broadcastId: marker.fromBroadcastId, broadcastStatus: "complete" });
    } catch {
      // Read below: it may have ended anyway.
    }
    if (stopped) {
      // The owner's Stop during the hand-over: both broadcasts end; nothing is handed over.
      await deps.youtube.transition(auth.credentials, { broadcastId: marker.newBroadcastId, broadcastStatus: "complete" }).catch(() => undefined);
    }
    const lives = await deps.youtube.lifecycles(auth.credentials, [marker.fromBroadcastId, marker.newBroadcastId]);
    const old = lives[marker.fromBroadcastId];
    ended = !old || old.lifeCycleStatus === "complete" || old.lifeCycleStatus === "revoked";
    const newEnded = !lives[marker.newBroadcastId] || lives[marker.newBroadcastId]!.lifeCycleStatus === "complete" || lives[marker.newBroadcastId]!.lifeCycleStatus === "revoked";
    if (!ended || (stopped && !newEnded)) {
      const next = attempts + 1;
      await writeMarker(channelId, { ...marker, attempts: next, lastAttemptAt: deps.clock() });
      if (next === HANDOVER_ALERT_ATTEMPTS) await deps.streams.event(channelId, "live_segment_end_old_retrying", { attempts: next, fromBroadcastId: marker.fromBroadcastId });
      return;
    }
    if (stopped) {
      await writeMarker(channelId, null);
      await deps.streams.event(channelId, "live_segment_switch_cancelled", { newBroadcastId: marker.newBroadcastId, phase: "handover" });
      return;
    }
    const open = await deps.segments.open(channelId);
    const oldRow = open.find((r) => r.broadcastId === marker.fromBroadcastId && r.endedAt === null);
    const newStart = isoTime(lives[marker.newBroadcastId]?.actualStartTime);
    const oldEnd = isoTime(old?.actualEndTime);
    const overlapMs = newStart !== null && oldEnd !== null ? oldEnd - newStart : null;
    if (oldRow) {
      const addToPlaylist = oldRow.recorded && settings.recordingsPlaylist !== null && deps.addToPlaylist !== undefined;
      await deps.segments.update(oldRow.id, {
        endedAt: new Date(oldEnd ?? deps.clock()),
        switchOverlapMs: overlapMs,
        rotationJson: JSON.stringify(await deps.playedVideos(channelId).catch(() => [])),
        recordingStatus: oldRow.recorded ? "recorded" : "none",
        playlistStatus: addToPlaylist ? "pending" : "none",
      });
    }
    await deps.segments.insert({ id: deps.newId(), channelId, broadcastId: marker.newBroadcastId, startedAt: new Date(newStart ?? deps.clock()), recorded: true, recordingStatus: "none", playlistStatus: "none", playlistAttempts: 0 });
    await writeMarker(channelId, null);
    retryAt.delete(channelId);
    await deps.streams.event(channelId, "live_segment_switched", { from: marker.fromBroadcastId, to: marker.newBroadcastId, overlapMs });
    deps.applyVideoSettings({ channelId, broadcastId: marker.newBroadcastId, credentialRef: auth.credentialRef, credentials: auth.credentials });
  }

  /** `cleanup`: the new broadcast is ended (live) or deleted (never live), retried until done; the old one is never touched. */
  async function stepCleanup(stream: StreamRow, marker: SwitchMarker, credentials: ResolvedCredentials): Promise<void> {
    const { channelId } = stream;
    const attempts = marker.attempts ?? 0;
    try {
      const life = (await deps.youtube.lifecycles(credentials, [marker.newBroadcastId]))[marker.newBroadcastId];
      if (life && (life.lifeCycleStatus === "live" || life.lifeCycleStatus === "liveStarting" || life.lifeCycleStatus === "testing")) {
        await deps.youtube.transition(credentials, { broadcastId: marker.newBroadcastId, broadcastStatus: "complete" });
      } else if (life && life.lifeCycleStatus !== "complete" && life.lifeCycleStatus !== "revoked") {
        await deps.youtube.deleteVideo(credentials, marker.newBroadcastId);
      }
    } catch (error) {
      await writeMarker(channelId, { ...marker, attempts: attempts + 1, lastAttemptAt: deps.clock() });
      if (attempts === 0) await deps.streams.event(channelId, "live_segment_cleanup_retry", { newBroadcastId: marker.newBroadcastId, message: messageOf(error) });
      return;
    }
    await writeMarker(channelId, null);
    if (marker.reason === "stream_stopped") {
      // The owner's Stop during a switch: not a failure, and not counted toward the daily cap.
      await deps.streams.event(channelId, "live_segment_switch_cancelled", { newBroadcastId: marker.newBroadcastId });
    } else {
      retryAt.set(channelId, deps.clock() + SWITCH_RETRY_MS);
      await deps.streams.event(channelId, "live_segment_cleaned_up", { newBroadcastId: marker.newBroadcastId, stage: marker.reason ?? "unknown", retryInMinutes: SWITCH_RETRY_MS / 60_000 });
    }
  }

  /** Plan §2.2 step 6: ended, recorded segments go into the recordings playlist, retried every 10 min for 2 h. */
  async function addRecordings(channelId: string, settings: SegmentSettings, now: number): Promise<void> {
    if (!settings.recordingsPlaylist || !deps.addToPlaylist) return;
    const due = (await deps.segments.open(channelId)).filter(
      (s) => s.playlistStatus === "pending" && s.endedAt !== null && now >= s.endedAt.getTime() + s.playlistAttempts * PLAYLIST_RETRY_MS
    );
    if (due.length === 0) return;
    const { credentialRef } = await deps.authorize(channelId);
    for (const segment of due) {
      const result = await deps.addToPlaylist({ credentialRef, channelId, playlistId: settings.recordingsPlaylist.id, videoId: segment.broadcastId }).catch((error: unknown) => ({ added: false, reason: messageOf(error) }));
      if (result.added) {
        await deps.segments.update(segment.id, { playlistStatus: "added", playlistAttempts: segment.playlistAttempts + 1 });
        await deps.streams.event(channelId, "live_segment_recording_added", { broadcastId: segment.broadcastId, playlistId: settings.recordingsPlaylist.id });
      } else if (segment.playlistAttempts + 1 >= PLAYLIST_MAX_ATTEMPTS) {
        await deps.segments.update(segment.id, { playlistStatus: "failed", playlistAttempts: segment.playlistAttempts + 1, failure: result.reason ?? "YouTube refused the playlist item" });
        await deps.streams.event(channelId, "live_segment_recording_not_added", { broadcastId: segment.broadcastId, reason: result.reason ?? null });
      } else {
        await deps.segments.update(segment.id, { playlistAttempts: segment.playlistAttempts + 1 });
      }
    }
  }

  async function tickLocked(channelId: string): Promise<void> {
    const stream = await deps.streams.get(channelId);
    if (!stream) return;
    const marker = readSwitchMarker(stream.segmentSwitchingJson);
    const settings = readSegmentSettings(stream.segmentsJson);
    const now = deps.clock();
    if (marker) {
      // A retry waits out its backoff BEFORE any call, the identity check included (quota: review).
      const attempts = marker.attempts ?? 0;
      if (marker.phase !== "going_live" && attempts > 0 && now - (marker.lastAttemptAt ?? 0) < stepRetryDelay(attempts)) return;
      // A switch in progress is always finished -- even after the owner's Stop (then the new broadcast is cleaned up).
      let auth: { credentialRef: unknown; credentials: ResolvedCredentials };
      try {
        auth = await deps.authorize(channelId);
      } catch {
        return; // Live writes off or no account: the marker waits, nothing half-done is lost.
      }
      if (marker.phase === "going_live" && stream.intent !== "on") {
        await writeMarker(channelId, { ...marker, phase: "cleanup", reason: "stream_stopped", attempts: 0 });
        return;
      }
      if (marker.phase === "going_live") await stepGoingLive(stream, marker, auth.credentials);
      else if (marker.phase === "handover") await stepHandover(stream, marker, auth, settings);
      else await stepCleanup(stream, marker, auth.credentials);
      return;
    }
    if (stream.intent !== "on" || !stream.broadcastId || !stream.streamId) return;
    await addRecordings(channelId, settings, now).catch(() => undefined);
    if (!settings.enabled) return;
    const segment = await currentSegment(stream);
    if (!segment) return;
    if (now < switchDueAt(settings, segment.startedAt.getTime())) return;
    if (now < (retryAt.get(channelId) ?? 0)) return;
    const today = await deps.streams.countEventsSince(channelId, ["live_segment_switched", "live_segment_switch_failed"], new Date(startOfUtcDay(now)));
    if (today >= DAILY_SWITCH_CAP) {
      const key = `${channelId}:${startOfUtcDay(now)}`;
      if (!capNotified.has(key)) {
        capNotified.add(key);
        await deps.streams.event(channelId, "live_segment_cap_reached", { cap: DAILY_SWITCH_CAP });
      }
      return;
    }
    let auth: { credentialRef: unknown; credentials: ResolvedCredentials };
    try {
      auth = await deps.authorize(channelId);
    } catch (error) {
      // Live writes off or a wrong channel: nothing was written. Reported once per retry window, not every tick.
      retryAt.set(channelId, now + SWITCH_RETRY_MS);
      await deps.streams.event(channelId, "live_segment_switch_failed", { stage: "authorize", message: messageOf(error), newBroadcastId: null });
      return;
    }
    await begin(stream, auth);
  }

  return {
    /** One short step for one channel (the runner calls it every tick). Never waits minutes; never throws for a refusal. */
    tick: (channelId: string): Promise<void> => deps.withBroadcastLock(channelId, () => tickLocked(channelId)),
  };
}

export type LiveSegments = ReturnType<typeof createLiveSegments>;

/** BL-205: what the page and the Operator see -- the settings, the running segment and the last 30 days (codes only, no text). */
export type SegmentsView = {
  channelId: string;
  enabled: boolean;
  lengthMinutes: number;
  switchHourUtc: number | null;
  recordingsPlaylist: { id: string; title: string } | null;
  current: { broadcastId: string; startedAt: string; switchDueAt: string | null } | null;
  segments: Array<{ broadcastId: string; startedAt: string; endedAt: string | null; overlapMs: number | null; rotation: string[]; recording: string; playlist: string }>;
  failures: Array<{ at: string; stage: string }>;
  /** When the last switch succeeded (a failure before it is no longer current). */
  lastSwitchedAt: string | null;
};

export function segmentsView(args: {
  channelId: string;
  settingsJson: string | null | undefined;
  broadcastId: string | null;
  intent: "on" | "off";
  rows: Array<{ broadcastId: string; startedAt: Date; endedAt: Date | null; switchOverlapMs: number | null; rotationJson: string | null; recordingStatus: string; playlistStatus: string }>;
  failures: Array<{ at: Date; detail: Record<string, unknown> }>;
  lastSwitchedAt?: Date | null;
}): SegmentsView {
  const settings = readSegmentSettings(args.settingsJson);
  const running = args.intent === "on" ? args.rows.find((r) => r.broadcastId === args.broadcastId && r.endedAt === null) : undefined;
  const rotation = (json: string | null) => {
    try {
      const parsed = json ? (JSON.parse(json) as unknown) : [];
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    channelId: args.channelId,
    enabled: settings.enabled,
    lengthMinutes: settings.lengthMinutes,
    switchHourUtc: settings.switchHourUtc,
    recordingsPlaylist: settings.recordingsPlaylist,
    current: running
      ? { broadcastId: running.broadcastId, startedAt: running.startedAt.toISOString(), switchDueAt: settings.enabled ? new Date(switchDueAt(settings, running.startedAt.getTime())).toISOString() : null }
      : null,
    segments: args.rows.map((r) => ({
      broadcastId: r.broadcastId,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      overlapMs: r.switchOverlapMs,
      rotation: rotation(r.rotationJson),
      recording: r.recordingStatus,
      playlist: r.playlistStatus,
    })),
    failures: args.failures.map((f) => ({ at: f.at.toISOString(), stage: typeof f.detail.stage === "string" ? f.detail.stage : "unknown" })),
    lastSwitchedAt: args.lastSwitchedAt?.toISOString() ?? null,
  };
}

/** The owner's segment settings from the form: checked by the schema (`v` is added here). */
export function parseSegmentSettingsInput(input: unknown): SegmentSettings {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return segmentSettingsSchema.parse({ v: 1, ...body });
}
