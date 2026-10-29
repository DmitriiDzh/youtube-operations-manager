// ---------------------------------------------------------------------------
// BL-233 (FO-REQ-0047; owner msgs 3786/3788) -- how fast an upload may send while live streams run on this computer.
//
// The Mac's uplink (Wi-Fi, about 10 Mbit/s) carries the live encoders and the upload together; with two streams at 6000k and a
// 4.7 GB upload the Cuban Jazz stream starved (0.676x, videoIngestionStarved). Two rules, both per computer:
//   1. While any stream here is on, the upload is held to `capMbps` (0 = no limit); with no stream it is never limited.
//   2. The guard: once a stream here has sent below 0.97x for `guardMinutes` in a row, no new chunk starts until every measured
//      stream is back at 0.99x or more for a minute. A hold never lasts more than 30 minutes: then the upload goes on at the limit,
//      and is not held again until the streams have recovered. 0 minutes = never held.
// The chunk being sent when a hold begins finishes at the limit (a PUT is never stalled: its socket timeout is 10 minutes).
//
// The speed is measured over the last minute from the encoder's output time (`outTime`), because ffmpeg's own `speed=` is the
// average since its run began: hours into a run it barely moves when the link starves, and never climbs back to 0.99 after.
// ffmpeg's figure is used only until a minute of samples is there.
//
// Pure and clock-injected: the live streams are read by a function the app layer plugs in (AGENTS.md §M -- publishing imports no
// live-streams code); absent, uploads are never limited.
// ---------------------------------------------------------------------------

export const STARVING_BELOW_SPEED = 0.97;
export const RECOVERED_AT_SPEED = 0.99;
export const RECOVERY_MS = 60_000;
export const HOLD_CEILING_MS = 30 * 60_000;
/** The live load is read again at most this often (every chunk slice asks). */
export const REFRESH_MS = 5_000;
/** A stream's sample older than this is a gap (its helper writes at least every 10 s): it neither starves nor recovers. */
export const SAMPLE_STALE_MS = 60_000;
/** The recent speed needs at least this much time between its first and last sample, and uses at most the last 90 s. */
export const SPEED_WINDOW_MIN_MS = 30_000;
export const SPEED_WINDOW_KEEP_MS = 90_000;
/** A limited chunk is sized to take about this long, in whole 256 KB units (YouTube's resumable granularity), at least one. */
export const LIMITED_CHUNK_SECONDS = 60;
const GRANULARITY = 256 * 1024;

/** One stream encoder on this computer as its helper last reported it. */
export type EncoderSample = {
  channelId: string;
  /** The helper is sending (fresh status, state running). Otherwise a gap. */
  running: boolean;
  /** When the helper wrote the sample (ms). */
  sampledAt: number;
  /** Seconds of output sent in the current run. */
  outTimeSeconds: number | null;
  /** ffmpeg's own speed (average since the run began). */
  speed: number | null;
};

export type LiveLoad = {
  /** Streams on this computer whose owner turned them on (starting and reconnecting ones still need the link). */
  streamsOn: number;
  capMbps: number;
  guardMinutes: number;
  encoders: EncoderSample[];
};

export type UploadBandwidthEvent =
  | { kind: "upload_held"; at: number; channelId: string; speed: number | null }
  | { kind: "upload_released"; at: number; reason: "recovered" | "ceiling" | "no_stream" | "guard_off"; channelId: string | null; heldMs: number };

export type UploadBandwidthMode = "uncapped" | "capped" | "held";

export type UploadBandwidthState = {
  mode: UploadBandwidthMode;
  capMbps: number;
  guardMinutes: number;
  streamsOn: number;
  heldSince: number | null;
  heldForChannelId: string | null;
  /** When the last hold ended at the 30-minute ceiling; cleared once the streams recover. */
  ceilingReleasedAt: number | null;
  /** The speed each running stream is judged by (recent where measured, else ffmpeg's), null in a gap. */
  speeds: Record<string, number | null>;
  evaluatedAt: number | null;
  /** The last time an upload asked whether it may send (an upload is under way or held when this is recent). */
  lastAskedAt: number | null;
};

type ChannelMemory = { samples: Array<{ at: number; out: number }>; belowSince: number | null; aboveSince: number | null };

export type GuardMemory = {
  streams: Map<string, ChannelMemory>;
  heldSince: number | null;
  heldForChannelId: string | null;
  ceilingReleasedAt: number | null;
};

export const newGuardMemory = (): GuardMemory => ({ streams: new Map(), heldSince: null, heldForChannelId: null, ceilingReleasedAt: null });

const finiteOrNull = (value: number | null | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The speed over the last 30-90 s of samples, or null when fewer than 30 s are there. */
function recentSpeed(samples: ReadonlyArray<{ at: number; out: number }>): number | null {
  const last = samples.at(-1);
  const first = samples[0];
  if (!last || !first || last.at - first.at < SPEED_WINDOW_MIN_MS) return null;
  return (last.out - first.out) / ((last.at - first.at) / 1000);
}

/**
 * One evaluation of the guard. Mutates `memory`; returns the mode and the events of this step. Exported for the acceptance
 * tests; the governor below calls it every `REFRESH_MS` at most.
 */
export function stepGuard(memory: GuardMemory, load: LiveLoad, now: number): { mode: UploadBandwidthMode; speeds: Record<string, number | null>; events: UploadBandwidthEvent[] } {
  const events: UploadBandwidthEvent[] = [];
  const guardMs = Math.max(0, Math.floor(load.guardMinutes)) * 60_000;
  const speeds: Record<string, number | null> = {};
  const seen = new Set<string>();
  for (const encoder of load.encoders) {
    seen.add(encoder.channelId);
    const channel = memory.streams.get(encoder.channelId) ?? { samples: [], belowSince: null, aboveSince: null };
    memory.streams.set(encoder.channelId, channel);
    const out = finiteOrNull(encoder.outTimeSeconds);
    const fresh = encoder.running && now - encoder.sampledAt <= SAMPLE_STALE_MS && now >= encoder.sampledAt - SAMPLE_STALE_MS;
    if (!fresh) {
      // A gap (helper restarting, waiting for a video, hung or gone): it says nothing about the link -- start measuring again.
      Object.assign(channel, { samples: [], belowSince: null, aboveSince: null });
      speeds[encoder.channelId] = null;
      continue;
    }
    if (out !== null) {
      const previous = channel.samples.at(-1);
      if (previous && out < previous.out) channel.samples = []; // a new run starts its output time from 0
      if (!previous || encoder.sampledAt > previous.at) channel.samples.push({ at: encoder.sampledAt, out });
      channel.samples = channel.samples.filter((s) => encoder.sampledAt - s.at <= SPEED_WINDOW_KEEP_MS);
    }
    const speed = recentSpeed(channel.samples) ?? finiteOrNull(encoder.speed);
    speeds[encoder.channelId] = speed;
    if (speed === null) {
      channel.belowSince = null;
      channel.aboveSince = null;
    } else if (speed < STARVING_BELOW_SPEED) {
      channel.belowSince ??= now;
      channel.aboveSince = null;
    } else if (speed >= RECOVERED_AT_SPEED) {
      channel.aboveSince ??= now;
      channel.belowSince = null;
    } else {
      channel.belowSince = null;
      channel.aboveSince = null;
    }
  }
  for (const id of [...memory.streams.keys()]) if (!seen.has(id)) memory.streams.delete(id);

  const measured = [...memory.streams.entries()].filter(([id]) => speeds[id] !== null && speeds[id] !== undefined);
  const recovered = measured.length > 0 && measured.every(([, c]) => c.aboveSince !== null && now - c.aboveSince >= RECOVERY_MS);

  const release = (reason: "recovered" | "ceiling" | "no_stream" | "guard_off") => {
    events.push({ kind: "upload_released", at: now, reason, channelId: memory.heldForChannelId, heldMs: now - (memory.heldSince ?? now) });
    memory.heldSince = null;
    memory.heldForChannelId = null;
  };

  if (load.streamsOn <= 0) {
    if (memory.heldSince !== null) release("no_stream");
    memory.ceilingReleasedAt = null;
    memory.streams.clear();
    return { mode: "uncapped", speeds, events };
  }
  if (recovered) memory.ceilingReleasedAt = null;
  if (memory.heldSince !== null) {
    if (guardMs === 0) release("guard_off");
    else if (now - memory.heldSince >= HOLD_CEILING_MS) {
      release("ceiling");
      memory.ceilingReleasedAt = now;
    } else if (recovered) release("recovered");
  } else if (guardMs > 0 && memory.ceilingReleasedAt === null) {
    const starving = measured.find(([, c]) => c.belowSince !== null && now - c.belowSince >= guardMs);
    if (starving) {
      memory.heldSince = now;
      memory.heldForChannelId = starving[0];
      events.push({ kind: "upload_held", at: now, channelId: starving[0], speed: speeds[starving[0]] ?? null });
    }
  }
  const mode: UploadBandwidthMode = memory.heldSince !== null ? "held" : load.capMbps > 0 ? "capped" : "uncapped";
  return { mode, speeds, events };
}

/** Bytes per second for a limit in Mbit/s (decimal megabits, as a link is rated). */
export const bytesPerSecond = (mbps: number) => (mbps * 1_000_000) / 8;

/** The chunk for the next request: the usual size uncapped; limited, about a minute of sending in whole 256 KB units. */
export function limitedChunkBytes(defaultBytes: number, rateBytesPerSecond: number | null): number {
  if (rateBytesPerSecond === null || rateBytesPerSecond <= 0) return defaultBytes;
  const units = Math.max(1, Math.floor((rateBytesPerSecond * LIMITED_CHUNK_SECONDS) / GRANULARITY));
  return Math.min(defaultBytes, units * GRANULARITY);
}

export type UploadBandwidthGovernor = ReturnType<typeof createUploadBandwidthGovernor>;

export function createUploadBandwidthGovernor(deps: {
  load(): Promise<LiveLoad>;
  clock(): number;
  sleep(ms: number): Promise<void>;
  onEvent?(event: UploadBandwidthEvent): void | Promise<void>;
  onLoadError?(error: unknown): void;
}) {
  const memory = newGuardMemory();
  let state: UploadBandwidthState = {
    mode: "uncapped",
    capMbps: 0,
    guardMinutes: 0,
    streamsOn: 0,
    heldSince: null,
    heldForChannelId: null,
    ceilingReleasedAt: null,
    speeds: {},
    evaluatedAt: null,
    lastAskedAt: null,
  };
  let inFlight: Promise<UploadBandwidthState> | null = null;
  // The token bucket: bytes that may go now (negative = owed), refilled at the limit since `refilledAt`.
  let tokens = 0;
  let refilledAt: number | null = null;

  async function evaluate(): Promise<UploadBandwidthState> {
    const now = deps.clock();
    let load: LiveLoad;
    try {
      load = await deps.load();
    } catch (error) {
      // The streams cannot be read: the last known state stands (an upload is never stopped by a failed read, only kept as it was).
      deps.onLoadError?.(error);
      state = { ...state, evaluatedAt: now };
      return state;
    }
    const capMbps = Number.isFinite(load.capMbps) && load.capMbps > 0 ? load.capMbps : 0;
    const step = stepGuard(memory, { ...load, capMbps }, now);
    state = {
      mode: step.mode,
      capMbps,
      guardMinutes: load.guardMinutes,
      streamsOn: load.streamsOn,
      heldSince: memory.heldSince,
      heldForChannelId: memory.heldForChannelId,
      ceilingReleasedAt: memory.ceilingReleasedAt,
      speeds: step.speeds,
      evaluatedAt: now,
      lastAskedAt: state.lastAskedAt,
    };
    for (const event of step.events) {
      try {
        await deps.onEvent?.(event);
      } catch {
        // a note that could not be written never changes what the upload does
      }
    }
    return state;
  }

  /** Reads the streams again when the last reading is older than `REFRESH_MS` (one reading at a time). */
  function refresh(force = false): Promise<UploadBandwidthState> {
    if (!force && state.evaluatedAt !== null && deps.clock() - state.evaluatedAt < REFRESH_MS) return Promise.resolve(state);
    inFlight ??= evaluate().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  /** The limit now in bytes per second; null = none. A held upload's chunk in flight finishes at the limit. */
  const rate = (): number | null => (state.streamsOn > 0 && state.capMbps > 0 && state.mode !== "uncapped" ? bytesPerSecond(state.capMbps) : null);

  return {
    refresh,
    /** Whether a new chunk (or a new upload) may start now. */
    async mayStart(): Promise<boolean> {
      state = { ...state, lastAskedAt: deps.clock() };
      return (await refresh()).mode !== "held";
    },
    /** The size of the next chunk (see `limitedChunkBytes`). */
    chunkBytes(defaultBytes: number): number {
      return limitedChunkBytes(defaultBytes, rate());
    },
    /** Waits until `bytes` more may be sent at the limit now (no wait without one). Called before each slice of a request body. */
    async pace(bytes: number): Promise<void> {
      await refresh();
      const limit = rate();
      const now = deps.clock();
      if (limit === null) {
        tokens = 0;
        refilledAt = null;
        return;
      }
      // A burst of at most a quarter of a second: the encoders' own buffers ride that out.
      const burst = Math.max(64 * 1024, limit / 4);
      tokens = refilledAt === null ? 0 : Math.min(burst, tokens + ((now - refilledAt) / 1000) * limit);
      refilledAt = now;
      tokens -= bytes;
      if (tokens < 0) await deps.sleep(Math.ceil((-tokens / limit) * 1000));
    },
    state: (): UploadBandwidthState => ({ ...state, speeds: { ...state.speeds } }),
  };
}

const GOVERNOR_KEY = Symbol.for("ytom.publishing.uploadBandwidth");
type GlobalWithGovernor = typeof globalThis & { [GOVERNOR_KEY]?: UploadBandwidthGovernor };

/** The governor of this process's upload runner, for the readers (the Operator's status, the Web UI). One per process. */
export function registerUploadBandwidthGovernor(governor: UploadBandwidthGovernor): void {
  (globalThis as GlobalWithGovernor)[GOVERNOR_KEY] = governor;
}

/** What the readers see: null while no upload runner with a live-streams reader runs in this process. */
export function uploadBandwidthStatus(now: number = Date.now()): (UploadBandwidthState & { uploadActive: boolean }) | null {
  const governor = (globalThis as GlobalWithGovernor)[GOVERNOR_KEY];
  if (!governor) return null;
  const state = governor.state();
  // The runner asks before every chunk and every 5 s while held: an ask within the last 30 s means an upload is under way.
  return { ...state, uploadActive: state.lastAskedAt !== null && now - state.lastAskedAt < 30_000 };
}
