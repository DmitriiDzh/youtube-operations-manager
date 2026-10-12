import path from "node:path";
import { DomainError, type LiveStreamsSettings } from "./contracts";
import type { LiveStreamBuffer } from "./buffer";
import { scrubSecrets } from "./playback.mjs";

// ---------------------------------------------------------------------------
// BL-176 (LIVE_STREAMS_PLAN.md §3.1/§3.6/§3.8, ADR 0036 §4–5) -- the server side of a running stream. It starts the
// encoder helper (detached, the key on stdin), adopts a helper that is already running after a server restart (its command
// line, pid and token must match), carries the helper's pass and position into the database, keeps the buffer filled, draws
// the next pass, and stops the encoder when YouTube has ended the broadcast. It never writes to YouTube: restarting the
// encoder is not a YouTube write (ADR 0036 §4), and the only YouTube calls here are reads (the key, the broadcast's status).
// Starting, stopping and restarting one stream never overlap (`withChannelLock`; independent review, 2026-10-12).
// ---------------------------------------------------------------------------

export type HelperStatus = {
  protocol: number;
  token: string;
  pid: number;
  state: string;
  passNumber: number;
  /** The videos of the pass the helper plays, in its order: the server's record of the pass follows it. */
  passVideoIds?: string[];
  position: { index: number; videoId: string | null; offset: number };
  lastExit: { at: number; code: number | null; signal: string | null; cause: string; ranSeconds: number } | null;
  progress: Record<string, unknown>;
  missingVideoId?: string | null;
  updatedAt: number;
};

export type HelperRecord = { pid: number; token: string; startedAt: number; protocol: number };

/** §3.10: YouTube's side of a stream at the last poll, kept in the stream's folder as `youtube.json` (no key, no URL). */
export type YoutubePoll = {
  checkedAt: number;
  lifeCycleStatus: string | null;
  /** Since when the broadcast has not been `live` while the stream is on; null when it is live. */
  notLiveSince: number | null;
  streamStatus: string | null;
  healthStatus: string | null;
  configurationIssues: Array<{ type: string; severity: string | null }>;
  viewers: number | null;
};

export type SupervisorStream = {
  channelId: string;
  intent: "on" | "off";
  streamId: string | null;
  broadcastId: string | null;
  orderMode: "sequence" | "shuffle";
  passNumber: number;
  passOrderJson: string | null;
  nextPassOrderJson: string | null;
  positionIndex: number;
  positionOffsetSeconds: number;
};

/** `freshPass`: a new pass from the rotation's start (Start). `rebuild`: Restart -- the rotation as it is now, keeping the video playing. */
export type StartOptions = { freshPass: boolean; rebuild?: boolean; playable?: readonly string[] };

export type SupervisorDependencies = {
  bufferRoot: string;
  settings(): Promise<LiveStreamsSettings & { host: { ok: true } | { ok: false; reason: string } }>;
  streams: {
    get(channelId: string): Promise<SupervisorStream | null>;
    update(channelId: string, set: Partial<Omit<SupervisorStream, "channelId">> & { positionUpdatedAt?: Date; onSince?: Date | null }): Promise<boolean>;
    /** The rotation in order with the original's path and durations. */
    videos(channelId: string): Promise<Array<{ videoId: string; originalPath: string; videoDurationSeconds: number | null; originalDurationSeconds: number | null }>>;
    /** §3.4: re-reads the rotation from YouTube; the playable ids in rotation order. */
    recheck(channelId: string): Promise<string[]>;
    event(channelId: string, kind: string, detail: Record<string, unknown>, at?: Date): Promise<void>;
  };
  buffer: Pick<LiveStreamBuffer, "sync" | "fileOf">;
  ffmpeg(dir: string | null): Promise<{ ffmpegPath: string; ffprobePath: string; features: { rtmps: boolean; h264Videotoolbox: boolean; libx264: boolean } } | null>;
  youtube: {
    /** The RTMPS address and the key (a read). Never stored; handed to the helper's stdin. */
    readIngestion(channelId: string, streamId: string): Promise<{ rtmpsIngestionAddress: string; streamName: string } | null>;
    /** The broadcast's `lifeCycleStatus` (a read); `found: false` when YouTube no longer has the broadcast (deleted in Studio). */
    readLifecycle(channelId: string, broadcastId: string): Promise<{ found: boolean; lifeCycleStatus: string | null }>;
    /** §3.10: the stream's status and health, issue types only (a read, never `cdn`). */
    readStreamHealth(channelId: string, streamId: string): Promise<{ streamStatus: string | null; healthStatus: string | null; configurationIssues: Array<{ type: string; severity: string | null }> } | null>;
    /** §3.10: concurrent viewers of the broadcast (a read). */
    readViewers(channelId: string, broadcastId: string): Promise<number | null>;
  };
  files: {
    read(file: string): Promise<string | null>;
    writeAtomic(file: string, text: string): Promise<void>;
  };
  process: {
    spawnHelper(streamDir: string, key: string): Promise<number>;
    isAlive(pid: number): boolean;
    /** True only when `pid` is THIS stream's encoder helper (its command line names the helper and the stream folder): a pid
     * reused after a reboot or a crash is never signalled. Throws when it cannot tell (fail closed: no second encoder). */
    isOurHelper(pid: number, streamDir: string): Promise<boolean>;
    /** Kills any ffmpeg still sending this stream's run list (its helper died without taking it along); the count killed. */
    killStrayEncoders(streamDir: string): Promise<number>;
    /** Signals the helper's whole process group (it is a group leader): its ffmpeg goes with it. */
    signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
    /** Waits up to `timeoutMs` for the pid to exit; true when it did. */
    waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
  };
  clock: () => Date;
  newToken: () => string;
  /** A random integer in [0, n) -- the shuffle. */
  random: (n: number) => number;
};

const HELPER_PROTOCOL = 1;
/** A status older than this means the helper is hung, not running (it rewrites its status at least every 10 s). */
export const HELPER_STALE_MS = 60_000;
/** How long a stopped helper gets to exit before its group is killed. */
export const HELPER_STOP_GRACE_MS = 10_000;

const LOCKS_KEY = Symbol.for("ytom.liveStreams.channelLocks");
type GlobalWithLocks = typeof globalThis & { [LOCKS_KEY]?: Map<string, Promise<unknown>> };

/**
 * Starting, stopping and restarting a stream's encoder never overlap: a Start and a background tick, or two requests, could
 * otherwise spawn two encoders on one key. Process-wide on `globalThis`: the routes and the background loop build separate
 * supervisors.
 */
export function withChannelLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  return withLock(channelId, fn);
}

/**
 * The buffer's own lock (independent review): copying gigabytes never holds the stream's lock, so a Stop or a Restart never
 * waits for a copy, and two syncs never delete each other's `.part` files.
 */
export function withBufferLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  return withLock(`${channelId}#buffer`, fn);
}

function withLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as GlobalWithLocks;
  const locks = (g[LOCKS_KEY] ??= new Map());
  const previous = locks.get(channelId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(channelId, tail);
  void tail.then(() => {
    if (locks.get(channelId) === tail) locks.delete(channelId);
  });
  return run;
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** A pass order: the playable videos in rotation order, or shuffled (not starting with `avoidFirst` when there is a choice). */
export function drawPassOrder(playable: readonly string[], mode: "sequence" | "shuffle", random: (n: number) => number, avoidFirst: string | null): string[] {
  if (mode === "sequence" || playable.length < 2) return [...playable];
  const order = [...playable];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (avoidFirst && order[0] === avoidFirst) [order[0], order[1]] = [order[1], order[0]];
  return order;
}

/**
 * The pass the helper plays: the stored order kept to the videos still playable, with the position moved to the next
 * playable video when the one it pointed at is no longer playable.
 */
export function playablePass(order: readonly string[], playable: readonly string[], position: { index: number; offset: number }): { order: string[]; index: number; offset: number } {
  const allowed = new Set(playable);
  const kept = order.filter((id) => allowed.has(id));
  const current = order[position.index];
  if (current !== undefined && allowed.has(current)) return { order: kept, index: kept.indexOf(current), offset: position.offset };
  const nextPlayable = order.slice(position.index + 1).find((id) => allowed.has(id));
  return { order: kept, index: nextPlayable ? kept.indexOf(nextPlayable) : kept.length, offset: 0 };
}

/** Restart (§3.9): the rotation as it is now; the video playing keeps its place (sequence) or goes first (shuffle). */
export function rebuiltPass(
  playable: readonly string[],
  mode: "sequence" | "shuffle",
  random: (n: number) => number,
  current: { videoId: string | null; offset: number }
): { order: string[]; index: number; offset: number } {
  let order = drawPassOrder(playable, mode, random, null);
  const id = current.videoId;
  if (id && order.includes(id) && mode === "shuffle") order = [id, ...order.filter((v) => v !== id)];
  const index = id ? order.indexOf(id) : -1;
  return index >= 0 ? { order, index, offset: current.offset } : { order, index: 0, offset: 0 };
}

export function createStreamSupervisor(deps: SupervisorDependencies) {
  const dirOf = (channelId: string) => path.join(deps.bufferRoot, channelId);
  const statusFile = (channelId: string) => path.join(dirOf(channelId), "status.json");
  const helperFile = (channelId: string) => path.join(dirOf(channelId), "helper.json");
  const eventsFile = (channelId: string) => path.join(dirOf(channelId), "events.jsonl");
  const eventsOffsetFile = (channelId: string) => path.join(dirOf(channelId), "events.offset");
  const youtubeFile = (channelId: string) => path.join(dirOf(channelId), "youtube.json");
  const lastMissing = new Map<string, string | null>();

  async function readStatus(channelId: string) {
    return parseJson<HelperStatus>(await deps.files.read(statusFile(channelId)));
  }

  /** This stream's helper process if one is alive and proven ours by its command line (running or hung). */
  async function liveHelper(channelId: string): Promise<HelperRecord | null> {
    const record = parseJson<HelperRecord>(await deps.files.read(helperFile(channelId)));
    if (!record || !deps.process.isAlive(record.pid)) return null;
    return (await deps.process.isOurHelper(record.pid, dirOf(channelId))) ? record : null;
  }

  /** The helper of this stream if it is running: alive and ours, token and pid matching, status fresh and not stopped. */
  async function runningHelper(channelId: string): Promise<{ record: HelperRecord; status: HelperStatus } | null> {
    const record = await liveHelper(channelId);
    if (!record) return null;
    const status = await readStatus(channelId);
    if (!status || status.token !== record.token || status.pid !== record.pid || status.protocol !== HELPER_PROTOCOL) return null;
    if (status.state === "stopped") return null;
    if (deps.clock().getTime() - status.updatedAt > HELPER_STALE_MS) return null;
    return { record, status };
  }

  async function bufferVideos(channelId: string) {
    return (await deps.streams.videos(channelId)).map((v) => ({ videoId: v.videoId, originalPath: v.originalPath, videoDurationSeconds: v.videoDurationSeconds }));
  }

  async function durationsOf(channelId: string) {
    return new Map((await deps.streams.videos(channelId)).map((v) => [v.videoId, v.originalDurationSeconds ?? v.videoDurationSeconds ?? 0]));
  }

  /** The buffer for the current position; a missing copy is recorded once per change. */
  async function syncBuffer(channelId: string, order: string[], index: number, nextPassFirst: string | null) {
    const settings = await deps.settings();
    const result = await deps.buffer.sync(channelId, {
      order,
      currentIndex: index,
      nextPassFirst,
      depth: settings.bufferDepth,
      refuseBelowBytes: settings.refuseBelowGb * 1024 ** 3,
      videos: await bufferVideos(channelId),
    });
    const key = result.missing ? `${result.missing.videoId}:${result.missing.reason}` : null;
    if ((lastMissing.get(channelId) ?? null) !== key) {
      lastMissing.set(channelId, key);
      if (result.missing) await deps.streams.event(channelId, "buffer_missing", { ...result.missing });
      else if (lastMissing.has(channelId)) await deps.streams.event(channelId, "buffer_restored", {});
    }
    return result;
  }

  /** Stops this stream's helper process -- running or hung -- with its ffmpeg (the process group); waits for it to exit. */
  async function stopRunning(channelId: string, reason: string): Promise<boolean> {
    const record = await liveHelper(channelId);
    if (!record) return false;
    deps.process.signalGroup(record.pid, "SIGTERM");
    if (!(await deps.process.waitForExit(record.pid, HELPER_STOP_GRACE_MS))) {
      deps.process.signalGroup(record.pid, "SIGKILL");
      await deps.process.waitForExit(record.pid, HELPER_STOP_GRACE_MS);
    }
    await deps.process.killStrayEncoders(dirOf(channelId));
    await deps.streams.event(channelId, "encoder_stop", { reason });
    return true;
  }

  type Prepared = { settings: LiveStreamsSettings; tools: NonNullable<Awaited<ReturnType<SupervisorDependencies["ffmpeg"]>>>; playable: string[]; passNumber: number; pass: { order: string[]; index: number; offset: number } };

  /**
   * Start, part 1 (no stream lock): the checks, the pass, and the buffer for its first videos (copying may take minutes, so it
   * runs under the buffer's lock only). Nothing is spawned and nothing about the stream is written yet.
   */
  async function prepareStart(channelId: string, options: StartOptions): Promise<Prepared> {
    const settings = await deps.settings();
    if (!settings.enabled || !settings.host.ok) throw new DomainError({ code: "live_streams_host_unsupported", message: settings.host.ok ? "The live-streams module is switched off in Settings" : settings.host.reason });
    const stream = await deps.streams.get(channelId);
    if (!stream || stream.intent !== "on" || !stream.streamId) throw new DomainError({ code: "validation_failed", message: "The stream is not on (press Start first)", details: { channelId } });
    if (await runningHelper(channelId)) throw new DomainError({ code: "validation_failed", message: "The encoder is already running", details: { channelId } });

    const tools = await deps.ffmpeg(settings.ffmpegDir);
    const encoderOk = settings.encoder === "libx264" ? tools?.features.libx264 : tools?.features.h264Videotoolbox;
    if (!tools || !tools.features.rtmps || !encoderOk) {
      throw new DomainError({ code: "validation_failed", message: `ffmpeg with rtmps and ${settings.encoder} is not installed on this computer`, details: { channelId } });
    }

    // Start has just re-read the rotation (§3.9 counts one videos.list); a restart re-reads it here (§3.4).
    const playable = options.playable ? [...options.playable] : await deps.streams.recheck(channelId);
    if (playable.length === 0) throw new DomainError({ code: "live_stream_video_refused", message: "No video in the rotation is playable (public, with its file)", details: { channelId, reason: "empty" } });

    const storedOrder = parseJson<string[]>(stream.passOrderJson);
    let passNumber = stream.passNumber;
    let pass: { order: string[]; index: number; offset: number };
    if (options.rebuild && !options.freshPass && storedOrder) {
      passNumber += 1;
      pass = rebuiltPass(playable, stream.orderMode, deps.random, { videoId: storedOrder[stream.positionIndex] ?? null, offset: stream.positionOffsetSeconds });
    } else if (options.freshPass || !storedOrder) {
      passNumber += 1;
      pass = { order: drawPassOrder(playable, stream.orderMode, deps.random, null), index: 0, offset: 0 };
    } else {
      pass = playablePass(storedOrder, playable, { index: stream.positionIndex, offset: stream.positionOffsetSeconds });
      if (pass.index >= pass.order.length) {
        passNumber += 1;
        pass = { order: drawPassOrder(playable, stream.orderMode, deps.random, storedOrder.at(-1) ?? null), index: 0, offset: 0 };
      }
    }

    const buffered = await withBufferLock(channelId, () => syncBuffer(channelId, pass.order, pass.index, null));
    if (!buffered.present.includes(pass.order[pass.index]) && !buffered.present.some((id) => playable.includes(id))) {
      throw new DomainError({ code: "live_stream_video_refused", message: `The first video could not be copied to this computer: ${buffered.missing?.detail ?? "unknown"}`, details: { channelId, reason: buffered.missing?.reason ?? "source_unavailable" } });
    }
    return { settings, tools, playable, passNumber, pass };
  }

  /**
   * Start, part 2 (under the stream's lock): the checks again, any helper or stray encoder dealt with, the pass recorded,
   * the key read from YouTube (a read, never stored) and the helper spawned with it on stdin.
   */
  async function commitStart(channelId: string, prepared: Prepared): Promise<{ pid: number }> {
    const { settings, tools, playable, passNumber, pass } = prepared;
    const stream = await deps.streams.get(channelId);
    // The owner may have pressed Stop while the buffer was being filled.
    if (!stream || stream.intent !== "on" || !stream.streamId) throw new DomainError({ code: "validation_failed", message: "The stream is not on (press Start first)", details: { channelId } });
    if (await runningHelper(channelId)) throw new DomainError({ code: "validation_failed", message: "The encoder is already running", details: { channelId } });
    const live = await liveHelper(channelId);
    if (live) {
      // A helper spawned moments ago may not have written its first status yet: it is starting, not hung (independent review).
      if (deps.clock().getTime() - live.startedAt < HELPER_STALE_MS) throw new DomainError({ code: "validation_failed", message: "The encoder is starting", details: { channelId } });
      await stopRunning(channelId, "hung");
    }
    // An ffmpeg left behind by a helper that was killed outright (it cannot take its ffmpeg along) would send beside the new one.
    if ((await deps.process.killStrayEncoders(dirOf(channelId))) > 0) await deps.streams.event(channelId, "encoder_stop", { reason: "stray" });

    await deps.streams.update(channelId, {
      passNumber,
      passOrderJson: JSON.stringify(pass.order),
      nextPassOrderJson: null,
      positionIndex: pass.index,
      positionOffsetSeconds: pass.offset,
      positionUpdatedAt: deps.clock(),
    });

    const ingestion = await deps.youtube.readIngestion(channelId, stream.streamId);
    if (!ingestion) throw new DomainError({ code: "validation_failed", message: "YouTube did not return the stream's ingestion address and key", details: { channelId } });

    const durations = await durationsOf(channelId);
    const token = deps.newToken();
    const plan = {
      protocol: HELPER_PROTOCOL,
      token,
      ffmpegPath: tools.ffmpegPath,
      ffprobePath: tools.ffprobePath,
      ingestUrl: ingestion.rtmpsIngestionAddress.replace(/\/+$/, ""),
      encoder: { codec: settings.encoder, bitrateKbps: settings.bitrateKbps },
      pass: { number: passNumber, videos: pass.order.map((id) => ({ videoId: id, file: deps.buffer.fileOf(channelId, id), duration: durations.get(id) ?? 0 })), startIndex: pass.index, startOffset: pass.offset },
      nextPass: null,
      playable,
      toleranceSeconds: 3,
    };
    await deps.files.writeAtomic(path.join(dirOf(channelId), "plan.json"), JSON.stringify(plan, null, 1));
    const pid = await deps.process.spawnHelper(dirOf(channelId), ingestion.streamName);
    await deps.files.writeAtomic(helperFile(channelId), JSON.stringify({ pid, token, startedAt: deps.clock().getTime(), protocol: HELPER_PROTOCOL } satisfies HelperRecord));
    await deps.streams.event(channelId, "encoder_start", { pid, passNumber, index: pass.index, offset: pass.offset, encoder: settings.encoder, bitrateKbps: settings.bitrateKbps });
    return { pid };
  }

  /** The helper's new event lines, from the offset already imported, with their own times. Scrubbed again on the way in. */
  async function importEvents(channelId: string): Promise<void> {
    const text = await deps.files.read(eventsFile(channelId));
    if (!text) return;
    const offset = Number((await deps.files.read(eventsOffsetFile(channelId))) ?? 0) || 0;
    const start = offset <= text.length ? offset : 0; // the file was replaced: start over
    const fresh = text.slice(start);
    const complete = fresh.slice(0, fresh.lastIndexOf("\n") + 1);
    if (!complete) return;
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      const parsed = parseJson<{ at?: number; kind?: string } & Record<string, unknown>>(scrubSecrets(line, []));
      if (!parsed?.kind) continue;
      const { at, kind, ...detail } = parsed;
      await deps.streams.event(channelId, `encoder_${kind}`, detail, typeof at === "number" && Number.isFinite(at) ? new Date(at) : undefined);
    }
    await deps.files.writeAtomic(eventsOffsetFile(channelId), String(start + complete.length));
  }

  return {
    runningHelper,
    /** This stream's helper process if one is alive and ours, running or not (the background loop stops strays with it). */
    liveHelper,

    startEncoder: async (channelId: string, options: StartOptions) => {
      const prepared = await prepareStart(channelId, options);
      return withChannelLock(channelId, () => commitStart(channelId, prepared));
    },

    /** Stops this stream's helper (only a process proven ours by its command line), with its ffmpeg. No YouTube write. */
    stopEncoder: (channelId: string, reason: string) => withChannelLock(channelId, () => stopRunning(channelId, reason)),

    /**
     * §3.9 Restart: the encoder stops and starts again on the same broadcast, with the pass rebuilt from the rotation as it is
     * now (edits apply at once; the video playing keeps its place while it is still in the rotation). No YouTube write.
     */
    restart: (channelId: string) =>
      withChannelLock(channelId, async () => {
        await stopRunning(channelId, "owner_restart");
        // Under the lock throughout, so the background loop cannot start an encoder in between (the buffer is mostly in place).
        return commitStart(channelId, await prepareStart(channelId, { freshPass: false, rebuild: true }));
      }),

    /**
     * One supervision step for a stream (every few seconds): import the helper's events, carry its pass and position into
     * the database, draw the next pass when the last video starts, keep the buffer filled.
     */
    async tick(channelId: string): Promise<{ running: boolean; status: HelperStatus | null }> {
      await importEvents(channelId);
      // The record and plan.json are changed under the stream's lock (never interleaved with a Restart); the buffer after it,
      // under its own lock.
      const step = await withChannelLock(channelId, async () => {
        const running = await runningHelper(channelId);
        if (!running) return { running: false as const, status: await readStatus(channelId) };
        const { status } = running;
        const stream = await deps.streams.get(channelId);
        if (!stream) return { running: true as const, status, buffer: null };
        let order = parseJson<string[]>(stream.passOrderJson) ?? [];
        let nextOrder = parseJson<string[]>(stream.nextPassOrderJson);

        // The helper's pass is the truth: when it moved on -- to the drawn pass or, if none was drawn in time, to the same
        // order without the videos no longer playable -- the record follows it.
        const helperOrder = Array.isArray(status.passVideoIds) ? status.passVideoIds : null;
        if (helperOrder && (status.passNumber !== stream.passNumber || JSON.stringify(helperOrder) !== JSON.stringify(order))) {
          const movedOn = status.passNumber !== stream.passNumber;
          order = helperOrder;
          if (movedOn) nextOrder = null;
          await deps.streams.update(channelId, { passNumber: status.passNumber, passOrderJson: JSON.stringify(order), ...(movedOn ? { nextPassOrderJson: null } : {}) });
        }
        await deps.streams.update(channelId, { positionIndex: status.position.index, positionOffsetSeconds: status.position.offset, positionUpdatedAt: deps.clock() });

        if (status.position.index >= order.length - 1 && !nextOrder) {
          const playable = await deps.streams.recheck(channelId);
          nextOrder = drawPassOrder(playable, stream.orderMode, deps.random, order.at(-1) ?? null);
          await deps.streams.update(channelId, { nextPassOrderJson: JSON.stringify(nextOrder) });
          const plan = parseJson<Record<string, unknown>>(await deps.files.read(path.join(dirOf(channelId), "plan.json")));
          if (plan) {
            const durations = await durationsOf(channelId);
            plan.nextPass = { number: status.passNumber + 1, videos: nextOrder.map((id) => ({ videoId: id, file: deps.buffer.fileOf(channelId, id), duration: durations.get(id) ?? 0 })) };
            plan.playable = playable;
            await deps.files.writeAtomic(path.join(dirOf(channelId), "plan.json"), JSON.stringify(plan, null, 1));
          }
        }
        return { running: true as const, status, buffer: { order, index: Math.min(status.position.index, Math.max(0, order.length - 1)), nextFirst: nextOrder?.[0] ?? null } };
      });
      if (step.running && step.buffer) {
        const b = step.buffer;
        await withBufferLock(channelId, () => syncBuffer(channelId, b.order, b.index, b.nextFirst));
      }
      return { running: step.running, status: step.status };
    },

    /**
     * §3.8: after a (re)start and on the periodic poll, the broadcast is read. If YouTube has ended it (`complete` or
     * `revoked`) or no longer has it (deleted in Studio), the encoder stops, the intent goes off, and an event records it --
     * no YouTube write is made.
     */
    async checkBroadcast(channelId: string): Promise<{ lifeCycleStatus: string | null; endedByYoutube: boolean }> {
      const stream = await deps.streams.get(channelId);
      if (!stream?.broadcastId) return { lifeCycleStatus: null, endedByYoutube: false };
      const read = await deps.youtube.readLifecycle(channelId, stream.broadcastId);
      const lifeCycleStatus = read.found ? read.lifeCycleStatus : "not_found";
      if (lifeCycleStatus === "complete" || lifeCycleStatus === "revoked" || lifeCycleStatus === "not_found") {
        await withChannelLock(channelId, () => stopRunning(channelId, `youtube_${lifeCycleStatus}`));
        await deps.streams.update(channelId, { intent: "off", onSince: null });
        await deps.streams.event(channelId, "youtube_ended", { broadcastId: stream.broadcastId, lifeCycleStatus });
        await deps.files.writeAtomic(youtubeFile(channelId), JSON.stringify({ checkedAt: deps.clock().getTime(), lifeCycleStatus, notLiveSince: null, streamStatus: null, healthStatus: null, configurationIssues: [], viewers: null } satisfies YoutubePoll));
        return { lifeCycleStatus, endedByYoutube: true };
      }
      // §3.10: the rest of the poll -- the stream's health and the viewers -- for the page and the bell.
      const previous = parseJson<YoutubePoll>(await deps.files.read(youtubeFile(channelId)));
      const now = deps.clock().getTime();
      const health = stream.streamId ? await deps.youtube.readStreamHealth(channelId, stream.streamId) : null;
      const viewers = lifeCycleStatus === "live" ? await deps.youtube.readViewers(channelId, stream.broadcastId) : null;
      const poll: YoutubePoll = {
        checkedAt: now,
        lifeCycleStatus,
        notLiveSince: lifeCycleStatus === "live" ? null : (previous?.notLiveSince ?? now),
        streamStatus: health?.streamStatus ?? null,
        healthStatus: health?.healthStatus ?? null,
        configurationIssues: health?.configurationIssues ?? [],
        viewers,
      };
      await deps.files.writeAtomic(youtubeFile(channelId), JSON.stringify(poll));
      if (previous?.lifeCycleStatus !== lifeCycleStatus) await deps.streams.event(channelId, "youtube_status", { lifeCycleStatus, streamStatus: poll.streamStatus, healthStatus: poll.healthStatus });
      return { lifeCycleStatus, endedByYoutube: false };
    },

    /** The last YouTube poll of this stream, if any. */
    async lastYoutubePoll(channelId: string): Promise<YoutubePoll | null> {
      return parseJson<YoutubePoll>(await deps.files.read(youtubeFile(channelId)));
    },

    /** The helper's last status, running or not (the page and the bell). */
    readStatus,
  };
}

export type StreamSupervisor = ReturnType<typeof createStreamSupervisor>;
