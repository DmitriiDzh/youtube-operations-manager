import path from "node:path";
import { DomainError, type LiveStreamsSettings } from "./contracts";
import type { LiveStreamBuffer } from "./buffer";
import { scrubSecrets } from "./playback.mjs";

// ---------------------------------------------------------------------------
// BL-176 (LIVE_STREAMS_PLAN.md §3.1/§3.6/§3.8, ADR 0036 §4–5) -- the server side of a running stream. It starts the
// encoder helper (detached, the key on stdin), adopts a helper that is already running after a server restart (pid AND
// token must match), carries the helper's position into the database, keeps the buffer filled, draws the next pass, and
// stops the encoder when YouTube has ended the broadcast. It never writes to YouTube: restarting the encoder is not a
// YouTube write (ADR 0036 §4), and the only YouTube calls here are reads (the key, the broadcast's status).
// ---------------------------------------------------------------------------

export type HelperStatus = {
  protocol: number;
  token: string;
  pid: number;
  state: string;
  passNumber: number;
  position: { index: number; videoId: string | null; offset: number };
  lastExit: { at: number; code: number | null; signal: string | null; cause: string; ranSeconds: number } | null;
  progress: Record<string, unknown>;
  missingVideoId?: string | null;
  updatedAt: number;
};

export type HelperRecord = { pid: number; token: string; startedAt: number; protocol: number };

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
    event(channelId: string, kind: string, detail: Record<string, unknown>): Promise<void>;
  };
  buffer: Pick<LiveStreamBuffer, "sync" | "fileOf">;
  ffmpeg(dir: string | null): Promise<{ ffmpegPath: string; ffprobePath: string; features: { rtmps: boolean; h264Videotoolbox: boolean; libx264: boolean } } | null>;
  youtube: {
    /** The RTMPS address and the key (a read). Never stored; handed to the helper's stdin. */
    readIngestion(channelId: string, streamId: string): Promise<{ rtmpsIngestionAddress: string; streamName: string } | null>;
    /** The broadcast's `lifeCycleStatus` (a read). */
    readLifecycle(channelId: string, broadcastId: string): Promise<string | null>;
  };
  files: {
    read(file: string): Promise<string | null>;
    writeAtomic(file: string, text: string): Promise<void>;
  };
  process: {
    spawnHelper(streamDir: string, key: string): Promise<number>;
    isAlive(pid: number): boolean;
    signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  };
  clock: () => Date;
  newToken: () => string;
  /** A random integer in [0, n) -- the shuffle. */
  random: (n: number) => number;
};

const HELPER_PROTOCOL = 1;
/** A status older than this means the helper is hung, not running (it writes progress every 5 s). */
export const HELPER_STALE_MS = 2 * 60_000;

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

export function createStreamSupervisor(deps: SupervisorDependencies) {
  const dirOf = (channelId: string) => path.join(deps.bufferRoot, channelId);
  const statusFile = (channelId: string) => path.join(dirOf(channelId), "status.json");
  const helperFile = (channelId: string) => path.join(dirOf(channelId), "helper.json");
  const eventsFile = (channelId: string) => path.join(dirOf(channelId), "events.jsonl");
  const eventsOffsetFile = (channelId: string) => path.join(dirOf(channelId), "events.offset");
  const lastMissing = new Map<string, string | null>();

  async function readStatus(channelId: string) {
    return parseJson<HelperStatus>(await deps.files.read(statusFile(channelId)));
  }

  /** The helper of this stream if it is running: pid alive, token and pid matching, status fresh. */
  async function runningHelper(channelId: string): Promise<{ record: HelperRecord; status: HelperStatus } | null> {
    const record = parseJson<HelperRecord>(await deps.files.read(helperFile(channelId)));
    if (!record || !deps.process.isAlive(record.pid)) return null;
    const status = await readStatus(channelId);
    if (!status || status.token !== record.token || status.pid !== record.pid || status.protocol !== HELPER_PROTOCOL) return null;
    if (status.state === "stopped") return null;
    if (deps.clock().getTime() - status.updatedAt > HELPER_STALE_MS) return null;
    return { record, status };
  }

  async function bufferVideos(channelId: string) {
    return (await deps.streams.videos(channelId)).map((v) => ({ videoId: v.videoId, originalPath: v.originalPath, videoDurationSeconds: v.videoDurationSeconds }));
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

  async function stopRunning(channelId: string, reason: string): Promise<boolean> {
    const running = await runningHelper(channelId);
    const record = running?.record ?? parseJson<HelperRecord>(await deps.files.read(helperFile(channelId)));
    if (!record || !deps.process.isAlive(record.pid)) return false;
    // Only a process proven to be ours by its token is signalled (a stale pid may belong to anything by now).
    const status = await readStatus(channelId);
    if (!status || status.token !== record.token || status.pid !== record.pid) return false;
    deps.process.signal(record.pid, "SIGTERM");
    await deps.streams.event(channelId, "encoder_stop", { reason });
    return true;
  }

  return {
    runningHelper,

    /**
     * Starts the encoder for a stream whose intent is on (after Start, at boot, or on Restart). Reads the key from
     * YouTube (a read), never stores it. Refuses, without any YouTube write, when something it needs is missing.
     */
    async startEncoder(channelId: string, options: { freshPass: boolean; playable?: readonly string[] }): Promise<{ pid: number }> {
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
      if (options.freshPass || !storedOrder) {
        passNumber += 1;
        pass = { order: drawPassOrder(playable, stream.orderMode, deps.random, null), index: 0, offset: 0 };
      } else {
        pass = playablePass(storedOrder, playable, { index: stream.positionIndex, offset: stream.positionOffsetSeconds });
        if (pass.index >= pass.order.length) {
          passNumber += 1;
          pass = { order: drawPassOrder(playable, stream.orderMode, deps.random, storedOrder.at(-1) ?? null), index: 0, offset: 0 };
        }
      }
      await deps.streams.update(channelId, {
        passNumber,
        passOrderJson: JSON.stringify(pass.order),
        nextPassOrderJson: null,
        positionIndex: pass.index,
        positionOffsetSeconds: pass.offset,
        positionUpdatedAt: deps.clock(),
      });

      const buffered = await syncBuffer(channelId, pass.order, pass.index, null);
      if (!buffered.present.includes(pass.order[pass.index]) && !buffered.present.some((id) => playable.includes(id))) {
        throw new DomainError({ code: "live_stream_video_refused", message: `The first video could not be copied to this computer: ${buffered.missing?.detail ?? "unknown"}`, details: { channelId, reason: buffered.missing?.reason ?? "source_unavailable" } });
      }

      const ingestion = await deps.youtube.readIngestion(channelId, stream.streamId);
      if (!ingestion) throw new DomainError({ code: "validation_failed", message: "YouTube did not return the stream's ingestion address and key", details: { channelId } });

      const durations = new Map((await deps.streams.videos(channelId)).map((v) => [v.videoId, v.originalDurationSeconds ?? v.videoDurationSeconds ?? 0]));
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
    },

    /** Stops this stream's helper (only one proven ours by its token). No YouTube write. */
    stopEncoder: (channelId: string, reason: string) => stopRunning(channelId, reason),

    /**
     * One supervision step for a stream (every few seconds): import the helper's events, carry its position into the
     * database, draw the next pass when the last video starts, keep the buffer filled.
     */
    async tick(channelId: string): Promise<{ running: boolean; status: HelperStatus | null }> {
      await importEvents(channelId);
      const running = await runningHelper(channelId);
      if (!running) return { running: false, status: await readStatus(channelId) };
      const { status } = running;
      const stream = await deps.streams.get(channelId);
      if (!stream) return { running: true, status };
      let order = parseJson<string[]>(stream.passOrderJson) ?? [];
      let nextOrder = parseJson<string[]>(stream.nextPassOrderJson);

      if (status.passNumber === stream.passNumber + 1 && nextOrder) {
        // The helper moved on to the pass drawn earlier.
        order = nextOrder;
        nextOrder = null;
        await deps.streams.update(channelId, { passNumber: status.passNumber, passOrderJson: JSON.stringify(order), nextPassOrderJson: null });
      }
      await deps.streams.update(channelId, { positionIndex: status.position.index, positionOffsetSeconds: status.position.offset, positionUpdatedAt: deps.clock() });

      if (status.position.index >= order.length - 1 && !nextOrder) {
        const playable = await deps.streams.recheck(channelId);
        nextOrder = drawPassOrder(playable, stream.orderMode, deps.random, order.at(-1) ?? null);
        await deps.streams.update(channelId, { nextPassOrderJson: JSON.stringify(nextOrder) });
        const planText = await deps.files.read(path.join(dirOf(channelId), "plan.json"));
        const plan = parseJson<Record<string, unknown>>(planText);
        if (plan) {
          const durations = new Map((await deps.streams.videos(channelId)).map((v) => [v.videoId, v.originalDurationSeconds ?? v.videoDurationSeconds ?? 0]));
          plan.nextPass = { number: status.passNumber + 1, videos: nextOrder.map((id) => ({ videoId: id, file: deps.buffer.fileOf(channelId, id), duration: durations.get(id) ?? 0 })) };
          plan.playable = playable;
          await deps.files.writeAtomic(path.join(dirOf(channelId), "plan.json"), JSON.stringify(plan, null, 1));
        }
      }
      await syncBuffer(channelId, order, Math.min(status.position.index, Math.max(0, order.length - 1)), nextOrder?.[0] ?? null);
      return { running: true, status };
    },

    /**
     * §3.8: after a (re)start and on the periodic poll, the broadcast is read. If YouTube has ended it (`complete` or
     * `revoked`), the encoder stops, the intent goes off, and an event records it -- no YouTube write is made.
     */
    async checkBroadcast(channelId: string): Promise<{ lifeCycleStatus: string | null; endedByYoutube: boolean }> {
      const stream = await deps.streams.get(channelId);
      if (!stream?.broadcastId) return { lifeCycleStatus: null, endedByYoutube: false };
      const lifeCycleStatus = await deps.youtube.readLifecycle(channelId, stream.broadcastId);
      if (lifeCycleStatus === "complete" || lifeCycleStatus === "revoked") {
        await stopRunning(channelId, `youtube_${lifeCycleStatus}`);
        await deps.streams.update(channelId, { intent: "off", onSince: null });
        await deps.streams.event(channelId, "youtube_ended", { broadcastId: stream.broadcastId, lifeCycleStatus });
        return { lifeCycleStatus, endedByYoutube: true };
      }
      return { lifeCycleStatus, endedByYoutube: false };
    },
  };

  /** The helper's new event lines, from the offset already imported. Scrubbed again on the way in. */
  async function importEvents(channelId: string): Promise<void> {
    const text = await deps.files.read(eventsFile(channelId));
    if (!text) return;
    const offset = Number((await deps.files.read(eventsOffsetFile(channelId))) ?? 0) || 0;
    const start = offset <= text.length ? offset : 0; // the file was replaced (a new helper): start over
    const fresh = text.slice(start);
    const complete = fresh.slice(0, fresh.lastIndexOf("\n") + 1);
    if (!complete) return;
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      const parsed = parseJson<{ at?: number; kind?: string } & Record<string, unknown>>(scrubSecrets(line, []));
      if (!parsed?.kind) continue;
      const { at, kind, ...detail } = parsed;
      void at;
      await deps.streams.event(channelId, `encoder_${kind}`, detail);
    }
    await deps.files.writeAtomic(eventsOffsetFile(channelId), String(start + complete.length));
  }
}

export type StreamSupervisor = ReturnType<typeof createStreamSupervisor>;
