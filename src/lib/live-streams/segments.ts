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

export const SEGMENT_MIN_MINUTES = 15;
/** 11 h 45 min: YouTube keeps a recording only under 12 h. */
export const SEGMENT_MAX_MINUTES = 705;
export const SEGMENT_DEFAULT_MINUTES = 660;
/** A quiet hour moves a switch that is due within this window of it. */
export const QUIET_HOUR_WINDOW_MS = 2 * 3_600_000;
/** How long the new segment may take to go live before the switch is given up. */
export const GO_LIVE_TIMEOUT_MS = 5 * 60_000;
export const GO_LIVE_POLL_MS = 3_000;
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

export type SwitchMarker = { startedAt: number; fromBroadcastId: string; newBroadcastId: string | null };

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
    insert(row: { id: string; channelId: string; broadcastId: string; startedAt: Date; recordingStatus: "none"; playlistStatus: "none"; playlistAttempts: 0 }): Promise<void>;
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
    /** The broadcasts' life-cycle states and YouTube's own start/end times; a broadcast YouTube no longer has is absent. */
    lifecycles(credentials: ResolvedCredentials, broadcastIds: string[]): Promise<Record<string, { lifeCycleStatus: string | null; actualStartTime: string | null; actualEndTime: string | null }>>;
    deleteVideo(credentials: ResolvedCredentials, videoId: string): Promise<void>;
  };
  /** BL-186 stage 3: the saved video settings for the new segment (in the background). */
  applyVideoSettings(args: { channelId: string; broadcastId: string; credentialRef: unknown; credentials: ResolvedCredentials }): void;
  /** playlist-management's add, plugged in by the app layer; absent = recordings are not added to playlists. */
  addToPlaylist?(args: { credentialRef: unknown; channelId: string; playlistId: string; videoId: string }): Promise<{ added: boolean; reason?: string }>;
  /** The rotation videos the encoder played in the segment, best effort. */
  playedVideos(channelId: string): Promise<string[]>;
  newId(): string;
  clock(): number;
  sleep(ms: number): Promise<void>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLiveSegments(deps: SegmentsDependencies) {
  /** Switches running in this process; a marker without one here was left by a crash or restart (plan §2.2 step 8). */
  const switching = new Set<string>();
  /** A failed attempt's earliest retry, per channel (and the last failure reported, so it is not repeated every tick). */
  const retryAt = new Map<string, number>();

  async function writeMarker(channelId: string, marker: SwitchMarker | null) {
    await deps.streams.update(channelId, { segmentSwitchingJson: marker ? JSON.stringify(marker) : null });
  }

  function readMarker(json: string | null | undefined): SwitchMarker | null {
    if (!json) return null;
    try {
      return JSON.parse(json) as SwitchMarker;
    } catch {
      return null;
    }
  }

  /** The segment row of the running broadcast, created when missing (the owner's Start made the first one). */
  async function currentSegment(stream: StreamRow): Promise<SegmentRow> {
    const open = await deps.segments.open(stream.channelId);
    const found = open.find((s) => s.broadcastId === stream.broadcastId && s.endedAt === null);
    if (found) return found;
    const row = { id: deps.newId(), channelId: stream.channelId, broadcastId: stream.broadcastId!, startedAt: stream.onSince ?? new Date(deps.clock()), recordingStatus: "none" as const, playlistStatus: "none" as const, playlistAttempts: 0 as const };
    await deps.segments.insert(row);
    return { ...row, endedAt: null };
  }

  /** Plan §2.2 step 8: a switch left half-done by a crash or restart -- exactly one live broadcast remains. */
  async function recover(stream: StreamRow, marker: SwitchMarker): Promise<void> {
    const { channelId } = stream;
    if (!marker.newBroadcastId) {
      await writeMarker(channelId, null);
      await deps.streams.event(channelId, "live_segment_recovered", { action: "nothing_created" });
      return;
    }
    const { credentials } = await deps.authorize(channelId);
    const states = await deps.youtube.lifecycles(credentials, [marker.newBroadcastId, marker.fromBroadcastId]);
    const fresh = states[marker.newBroadcastId];
    let action: string;
    if (!fresh) {
      action = "new_gone";
    } else if (fresh.lifeCycleStatus === "live" && stream.broadcastId === marker.newBroadcastId) {
      if (states[marker.fromBroadcastId]?.lifeCycleStatus === "live") await deps.youtube.transition(credentials, { broadcastId: marker.fromBroadcastId, broadcastStatus: "complete" });
      action = "old_completed";
    } else if (fresh.lifeCycleStatus === "live") {
      await deps.youtube.transition(credentials, { broadcastId: marker.newBroadcastId, broadcastStatus: "complete" });
      action = "new_completed";
    } else if (fresh.lifeCycleStatus === "complete" || fresh.lifeCycleStatus === "revoked") {
      action = "new_ended";
    } else {
      await deps.youtube.deleteVideo(credentials, marker.newBroadcastId);
      action = "new_deleted";
    }
    await writeMarker(channelId, null);
    await deps.streams.event(channelId, "live_segment_recovered", { action, from: marker.fromBroadcastId, to: marker.newBroadcastId });
  }

  async function fail(channelId: string, stage: string, error: unknown, newBroadcastId: string | null, credentials: ResolvedCredentials | null) {
    let deleted = false;
    if (newBroadcastId && credentials) {
      // The new segment never went live: it is removed, so no empty broadcast is left behind (plan §2.2 step 7).
      deleted = await deps.youtube.deleteVideo(credentials, newBroadcastId).then(
        () => true,
        () => false
      );
    }
    await writeMarker(channelId, null);
    retryAt.set(channelId, deps.clock() + SWITCH_RETRY_MS);
    await deps.streams.event(channelId, "live_segment_switch_failed", { stage, message: messageOf(error), newBroadcastId, newDeleted: deleted, retryInMinutes: SWITCH_RETRY_MS / 60_000 });
  }

  /** Plan §2.2 steps 2-6. */
  async function runSwitch(stream: StreamRow, segment: SegmentRow, settings: SegmentSettings): Promise<void> {
    const { channelId } = stream;
    const from = stream.broadcastId!;
    let auth: { credentialRef: unknown; credentials: ResolvedCredentials };
    try {
      auth = await deps.authorize(channelId);
    } catch (error) {
      // Live writes off or a wrong channel: nothing was written. Reported once per retry window, not every tick.
      await fail(channelId, "authorize", error, null, null);
      return;
    }
    const { credentials, credentialRef } = auth;
    const marker: SwitchMarker = { startedAt: deps.clock(), fromBroadcastId: from, newBroadcastId: null };
    await writeMarker(channelId, marker);
    let to: string | null = null;
    try {
      const broadcast = await deps.broadcastSettings(channelId);
      ({ broadcastId: to } = await deps.youtube.insertBroadcast(credentials, {
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
      await writeMarker(channelId, { ...marker, newBroadcastId: to });
      await deps.streams.event(channelId, "youtube_write", { method: "liveBroadcasts.insert", broadcastId: to, segment: true });
    } catch (error) {
      await fail(channelId, "insert", error, null, null);
      return;
    }
    try {
      await deps.youtube.bind(credentials, { broadcastId: to, streamId: stream.streamId! });
      await deps.streams.event(channelId, "youtube_write", { method: "liveBroadcasts.bind", broadcastId: to, streamId: stream.streamId, segment: true });
    } catch (error) {
      await fail(channelId, "bind", error, to, credentials);
      return;
    }
    // Make the new segment live, polling until it is (at most 5 min). The old one is still live on the same stream meanwhile.
    const deadline = deps.clock() + GO_LIVE_TIMEOUT_MS;
    let live = false;
    let lastError: unknown = null;
    while (!live && deps.clock() < deadline) {
      try {
        await deps.youtube.transition(credentials, { broadcastId: to, broadcastStatus: "live" });
      } catch (error) {
        lastError = error;
      }
      const states = await deps.youtube.lifecycles(credentials, [to]).catch(() => ({}) as Record<string, { lifeCycleStatus: string | null }>);
      live = states[to]?.lifeCycleStatus === "live";
      if (!live) await deps.sleep(GO_LIVE_POLL_MS);
    }
    if (!live) {
      await fail(channelId, "go_live", lastError ?? new Error("the new segment did not go live within 5 minutes"), to, credentials);
      return;
    }
    // The owner may have pressed Stop meanwhile: then the new segment is ended too, and nothing is handed over.
    const now0 = await deps.streams.get(channelId);
    if (!now0 || now0.intent !== "on" || now0.broadcastId !== from) {
      await deps.youtube.transition(credentials, { broadcastId: to, broadcastStatus: "complete" }).catch(() => undefined);
      await writeMarker(channelId, null);
      await deps.streams.event(channelId, "live_segment_switch_failed", { stage: "stream_changed", message: "the stream was stopped or changed during the switch", newBroadcastId: to, newDeleted: false, retryInMinutes: 0 });
      return;
    }
    // Hand over: the stream row names the new segment BEFORE the old one ends, so the broadcast check never takes the old
    // segment's end for the stream's end (plan §2.2 step 5).
    await deps.streams.update(channelId, { broadcastId: to });
    let oldEnded = false;
    for (let attempt = 0; attempt < 3 && !oldEnded; attempt++) {
      try {
        await deps.youtube.transition(credentials, { broadcastId: from, broadcastStatus: "complete" });
        oldEnded = true;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await deps.sleep(GO_LIVE_POLL_MS);
      }
    }
    const states = await deps.youtube.lifecycles(credentials, [from, to]).catch(() => ({}) as Record<string, { actualStartTime: string | null; actualEndTime: string | null }>);
    const newStart = states[to]?.actualStartTime ? Date.parse(states[to]!.actualStartTime!) : null;
    const oldEnd = states[from]?.actualEndTime ? Date.parse(states[from]!.actualEndTime!) : null;
    const overlapMs = newStart !== null && oldEnd !== null ? oldEnd - newStart : null;
    const now = deps.clock();
    await deps.segments.update(segment.id, {
      endedAt: new Date(oldEnd ?? now),
      switchOverlapMs: overlapMs,
      rotationJson: JSON.stringify(await deps.playedVideos(channelId).catch(() => [])),
      recordingStatus: oldEnded ? "recorded" : "failed",
      playlistStatus: settings.recordingsPlaylist && deps.addToPlaylist ? "pending" : "none",
      ...(oldEnded ? {} : { failure: `the old segment could not be ended: ${messageOf(lastError)}` }),
    });
    await deps.segments.insert({ id: deps.newId(), channelId, broadcastId: to, startedAt: new Date(newStart ?? now), recordingStatus: "none", playlistStatus: "none", playlistAttempts: 0 });
    await writeMarker(channelId, null);
    retryAt.delete(channelId);
    await deps.streams.event(channelId, "live_segment_switched", { from, to, overlapMs, oldEnded });
    deps.applyVideoSettings({ channelId, broadcastId: to, credentialRef, credentials });
  }

  /** Plan §2.2 step 6: ended segments go into the recordings playlist, retried every 10 min for 2 h. */
  async function addRecordings(channelId: string, settings: SegmentSettings, now: number): Promise<void> {
    if (!settings.recordingsPlaylist || !deps.addToPlaylist) return;
    for (const segment of await deps.segments.open(channelId)) {
      if (segment.playlistStatus !== "pending" || !segment.endedAt) continue;
      if (now < segment.endedAt.getTime() + segment.playlistAttempts * PLAYLIST_RETRY_MS) continue;
      const { credentialRef } = await deps.authorize(channelId);
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

  return {
    /** One tick for one channel (the runner calls it for a running stream). Never throws for a YouTube refusal. */
    async tick(channelId: string): Promise<void> {
      if (switching.has(channelId)) return;
      const stream = await deps.streams.get(channelId);
      if (!stream || stream.intent !== "on" || !stream.broadcastId || !stream.streamId) return;
      switching.add(channelId);
      try {
        const marker = readMarker(stream.segmentSwitchingJson);
        if (marker) {
          await recover(stream, marker);
          return;
        }
        const settings = readSegmentSettings(stream.segmentsJson);
        const now = deps.clock();
        await addRecordings(channelId, settings, now).catch(() => undefined);
        if (!settings.enabled) return;
        const segment = await currentSegment(stream);
        if (now < switchDueAt(settings, segment.startedAt.getTime())) return;
        if (now < (retryAt.get(channelId) ?? 0)) return;
        const today = await deps.streams.countEventsSince(channelId, ["live_segment_switched", "live_segment_switch_failed"], new Date(startOfUtcDay(now)));
        if (today >= DAILY_SWITCH_CAP) {
          if (!retryAt.has(channelId)) await deps.streams.event(channelId, "live_segment_cap_reached", { cap: DAILY_SWITCH_CAP });
          retryAt.set(channelId, startOfUtcDay(now) + 86_400_000);
          return;
        }
        await runSwitch(stream, segment, settings);
      } finally {
        switching.delete(channelId);
      }
    },

    /** Whether a switch of this channel is running now (Start/Stop wait for it through the shared lock in the wiring). */
    isSwitching: (channelId: string) => switching.has(channelId),
  };
}

export type LiveSegments = ReturnType<typeof createLiveSegments>;
