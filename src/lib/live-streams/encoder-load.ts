import { HELPER_STALE_MS, type HelperStatus } from "./supervisor";

// ---------------------------------------------------------------------------
// BL-233 (FO-REQ-0047) -- each stream encoder on this computer as its helper last reported it (`status.json` progress), in numbers:
// the one place that parses ffmpeg's progress fields. Read by the upload's bandwidth limit (through the app layer, AGENTS.md §M) and
// shown to the Operator (`factory_live_get_status.encoders`) and on the stream's page. Local file reads only; never a key or URL.
// ---------------------------------------------------------------------------

export type EncoderReading = {
  channelId: string;
  /** The owner's intent for the stream is on. */
  intentOn: boolean;
  /** The helper's state when its status is fresh (`running`, `replaying`, `restarting`, `waiting_for_source`...); null otherwise. */
  helperState: string | null;
  /** Sending now: a fresh status in state `running` or `replaying` (both send ffmpeg's output). */
  running: boolean;
  /** When the helper wrote the status (ms); null without one. */
  sampledAt: number | null;
  /** When ffmpeg reported the progress below (`progress.at`); null for a helper started before it was stamped. */
  progressAt: number | null;
  /** Seconds of output sent in the current ffmpeg run. */
  outTimeSeconds: number | null;
  /** ffmpeg's `speed=` -- the average since the run began (1.0 = real time). */
  speed: number | null;
  /** ffmpeg's `bitrate=` in kbit/s (what the output averages). */
  bitrateKbps: number | null;
  /** The bitrate the encoder was started with (`plan.json`). */
  targetBitrateKbps: number | null;
  /**
   * Seconds the output is behind the clock in the current run (the encoder reads in real time, so a starved link shows here).
   * From the run's start time when the helper reports it (helpers started after BL-233); else estimated from the speed.
   */
  lagSeconds: number | null;
  lagEstimated: boolean;
};

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** ffmpeg's `speed=0.973x` (or a number); `N/A`, empty or nonsense -> null. */
export function parseEncoderSpeed(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*x\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}

/** ffmpeg's `bitrate=3980.2kbits/s` -> 3980.2; `N/A` and anything else -> null. */
export function parseEncoderBitrateKbps(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*kbits\/s\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}

const round = (value: number | null, digits: number) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);

/** One stream's reading from its helper status (null = none) and plan bitrate, at `now`. */
export function encoderReading(input: { channelId: string; intentOn: boolean; status: HelperStatus | null; targetBitrateKbps: number | null }, now: number): EncoderReading {
  const status = input.status;
  const updatedAt = finite(status?.updatedAt);
  const fresh = status !== null && updatedAt !== null && now - updatedAt <= HELPER_STALE_MS && status.state !== "stopped";
  const helperState = fresh && typeof status.state === "string" ? status.state : null;
  const running = helperState === "running" || helperState === "replaying";
  const progress = status && typeof status.progress === "object" && status.progress !== null ? status.progress : {};
  const outTime = finite(progress.outTime);
  const speed = parseEncoderSpeed(progress.speed);
  const runStartedAt = finite(progress.runStartedAt);
  const progressAt = finite(progress.at);
  // The output time belongs to the progress block's time, not to a later heartbeat's write.
  const outAt = progressAt ?? updatedAt;
  let lagSeconds: number | null = null;
  let lagEstimated = false;
  if (running && outTime !== null && outAt !== null) {
    if (runStartedAt !== null && runStartedAt <= outAt) lagSeconds = Math.max(0, (outAt - runStartedAt) / 1000 - outTime);
    else if (speed !== null && speed > 0) {
      lagSeconds = Math.max(0, outTime * (1 / speed - 1));
      lagEstimated = true;
    }
  }
  const target = finite(input.targetBitrateKbps);
  return {
    channelId: input.channelId,
    intentOn: input.intentOn,
    helperState,
    running,
    sampledAt: updatedAt,
    progressAt: running ? progressAt : null,
    outTimeSeconds: running ? outTime : null,
    speed: running ? speed : null,
    bitrateKbps: running ? round(parseEncoderBitrateKbps(progress.bitrate), 1) : null,
    targetBitrateKbps: target !== null && target > 0 ? Math.round(target) : null,
    lagSeconds: round(lagSeconds, 0),
    lagEstimated: lagSeconds !== null && lagEstimated,
  };
}
