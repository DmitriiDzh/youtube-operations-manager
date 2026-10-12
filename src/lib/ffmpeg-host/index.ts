import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// BL-176 (docs/roadmap/plans/LIVE_STREAMS_PLAN.md §3.2, ADR 0036) -- the one place that finds ffmpeg/ffprobe on this
// computer, checks their features and runs them for a result. A shared leaf (AGENTS.md §M): the live-streams module uses
// it today; any later feature that needs ffmpeg uses it too, never its own `execFile("ffmpeg")`. Spawning the long-lived
// encoder is the live-streams helper's own job (it scrubs every line ffmpeg prints); this module only runs short probes.
// ---------------------------------------------------------------------------

export type FfmpegFeatures = { rtmps: boolean; h264Videotoolbox: boolean; libx264: boolean };
export type FfmpegTools = { ffmpegPath: string; ffprobePath: string; version: string; features: FfmpegFeatures };

export type MediaProbe = {
  durationSeconds: number | null;
  sizeBytes: number | null;
  video: { codec: string; width: number | null; height: number | null; frameRate: number | null } | null;
  audio: { codec: string; sampleRate: number | null; channels: number | null } | null;
  /** Number of audio and video streams (the encoder maps the first of each). */
  audioStreams: number;
  videoStreams: number;
};

/** Runs a program with arguments (never a shell) and returns its stdout. */
export type RunTool = (file: string, args: readonly string[], options: { timeoutMs: number }) => Promise<string>;

export const runTool: RunTool = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

/** Where Homebrew and the usual installers put ffmpeg, tried after a configured path and before PATH. */
const COMMON_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Parses `ffmpeg -protocols` and `ffmpeg -encoders` output into the three features the live streams need. */
export function parseFeatures(protocolsOutput: string, encodersOutput: string): FfmpegFeatures {
  const outputProtocols = protocolsOutput.split(/\r?\n/).reduce<{ inOutput: boolean; names: Set<string> }>(
    (acc, raw) => {
      const line = raw.trim();
      if (/^Output:/i.test(line)) return { inOutput: true, names: acc.names };
      if (/^Input:/i.test(line)) return { inOutput: false, names: acc.names };
      if (acc.inOutput && /^[a-z0-9_]+$/i.test(line)) acc.names.add(line.toLowerCase());
      return acc;
    },
    { inOutput: false, names: new Set<string>() }
  ).names;
  const encoders = new Set(
    encodersOutput
      .split(/\r?\n/)
      .map((line) => /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name))
  );
  return { rtmps: outputProtocols.has("rtmps"), h264Videotoolbox: encoders.has("h264_videotoolbox"), libx264: encoders.has("libx264") };
}

/**
 * Finds ffmpeg and ffprobe (the configured folder first, then the common install folders, then PATH) and reads their
 * version and features. `null` when either tool is missing or does not run.
 */
export async function detectFfmpeg(
  options: { configuredDir?: string | null; pathEnv?: string; run?: RunTool; exists?: (file: string) => Promise<boolean> } = {}
): Promise<FfmpegTools | null> {
  const run = options.run ?? runTool;
  const exists = options.exists ?? isExecutable;
  const pathDirs = (options.pathEnv ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const dirs = [...(options.configuredDir ? [options.configuredDir] : []), ...COMMON_DIRS, ...pathDirs];
  for (const dir of [...new Set(dirs)]) {
    const ffmpegPath = path.join(dir, "ffmpeg");
    const ffprobePath = path.join(dir, "ffprobe");
    if (!(await exists(ffmpegPath)) || !(await exists(ffprobePath))) continue;
    try {
      const versionOutput = await run(ffmpegPath, ["-hide_banner", "-version"], { timeoutMs: 15_000 });
      const version = /ffmpeg version (\S+)/.exec(versionOutput)?.[1] ?? "unknown";
      const protocols = await run(ffmpegPath, ["-hide_banner", "-protocols"], { timeoutMs: 15_000 });
      const encoders = await run(ffmpegPath, ["-hide_banner", "-encoders"], { timeoutMs: 15_000 });
      return { ffmpegPath, ffprobePath, version, features: parseFeatures(protocols, encoders) };
    } catch {
      continue;
    }
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "" || value === "N/A") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function frameRateOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [num, den] = value.split("/").map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return Math.round((num / den) * 1000) / 1000;
}

/** Parses `ffprobe -show_format -show_streams -of json` output. */
export function parseProbe(json: string): MediaProbe {
  const data = JSON.parse(json) as {
    format?: { duration?: unknown; size?: unknown };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: unknown; height?: unknown; r_frame_rate?: unknown; sample_rate?: unknown; channels?: unknown }>;
  };
  const streams = data.streams ?? [];
  const videos = streams.filter((s) => s.codec_type === "video");
  const audios = streams.filter((s) => s.codec_type === "audio");
  const v = videos[0];
  const a = audios[0];
  return {
    durationSeconds: toNumber(data.format?.duration),
    sizeBytes: toNumber(data.format?.size),
    video: v ? { codec: v.codec_name ?? "unknown", width: toNumber(v.width), height: toNumber(v.height), frameRate: frameRateOf(v.r_frame_rate) } : null,
    audio: a ? { codec: a.codec_name ?? "unknown", sampleRate: toNumber(a.sample_rate), channels: toNumber(a.channels) } : null,
    audioStreams: audios.length,
    videoStreams: videos.length,
  };
}

export async function probeMedia(tools: Pick<FfmpegTools, "ffprobePath">, file: string, run: RunTool = runTool): Promise<MediaProbe> {
  const output = await run(
    tools.ffprobePath,
    ["-v", "error", "-show_entries", "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels", "-of", "json", file],
    { timeoutMs: 60_000 }
  );
  return parseProbe(output);
}

/** The greatest keyframe time at or before `offsetSeconds` from `ffprobe ... -show_entries frame=pts_time -of csv=p=0` output. */
export function pickKeyframeAtOrBefore(csv: string, offsetSeconds: number): number | null {
  let best: number | null = null;
  for (const line of csv.split(/\r?\n/)) {
    const t = Number(line.trim().split(",")[0]);
    if (line.trim() === "" || !Number.isFinite(t)) continue;
    if (t <= offsetSeconds + 1e-6 && (best === null || t > best)) best = t;
  }
  return best;
}

/**
 * The source keyframe at or before `offsetSeconds` (§3.6): a run whose `inpoint` is this time starts exactly there.
 * Looks back up to `windowSeconds`; `null` when none is found in it (the caller decides; never silently 0, which would
 * replay the file from its start).
 */
export async function keyframeAtOrBefore(
  tools: Pick<FfmpegTools, "ffprobePath">,
  file: string,
  offsetSeconds: number,
  options: { windowSeconds?: number; run?: RunTool } = {}
): Promise<number | null> {
  if (offsetSeconds <= 0) return 0;
  const from = Math.max(0, offsetSeconds - (options.windowSeconds ?? 30));
  const output = await (options.run ?? runTool)(
    tools.ffprobePath,
    ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-read_intervals", `${from}%${offsetSeconds + 0.001}`, "-of", "csv=p=0", file],
    { timeoutMs: 60_000 }
  );
  return pickKeyframeAtOrBefore(output, offsetSeconds);
}
