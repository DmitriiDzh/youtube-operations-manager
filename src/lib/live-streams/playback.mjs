// ---------------------------------------------------------------------------
// BL-176 (docs/roadmap/plans/LIVE_STREAMS_PLAN.md §3.6/§3.7, ADR 0036) -- the playback rules shared by the server and the
// encoder helper. Plain JavaScript (JSDoc types) on purpose: the helper is a standalone `node` process that outlives
// server restarts and cannot load the app's TypeScript, and the server imports this same file -- one owner for each rule.
// No imports, no I/O.
// ---------------------------------------------------------------------------

/**
 * Seconds a run plays from `startIndex` at `startOffset` to the end of the list.
 * @param {readonly number[]} durations
 * @param {number} startIndex
 * @param {number} startOffset
 * @returns {number}
 */
export function passLength(durations, startIndex, startOffset) {
  return durations.slice(startIndex).reduce((sum, d) => sum + d, 0) - startOffset;
}

/**
 * Which video plays, and where in it, `outTimeSeconds` into a run that started at `startIndex` / `startOffset`. The run's
 * `inpoint` is a source keyframe, so the run starts exactly there (§3.6).
 * @param {readonly number[]} durations
 * @param {{ startIndex: number; startOffset: number }} start
 * @param {number} outTimeSeconds
 * @returns {{ index: number; offset: number; passEnded: boolean }}
 */
export function locatePlayback(durations, start, outTimeSeconds) {
  let index = start.startIndex;
  let offset = start.startOffset + Math.max(0, outTimeSeconds);
  while (index < durations.length && offset >= durations[index]) {
    offset -= durations[index];
    index += 1;
  }
  if (index >= durations.length) return { index: durations.length, offset: 0, passEnded: true };
  return { index, offset: Math.round(offset * 1000) / 1000, passEnded: false };
}

/**
 * §3.6: ffmpeg exits with code 0 both at the end of its list and when a listed file is missing, so the exit code cannot
 * tell them apart. A run is a pass end only if it played (within the tolerance) as long as its list.
 * @param {{ outTimeSeconds: number; expectedSeconds: number; toleranceSeconds: number }} args
 * @returns {"pass_end" | "early_end"}
 */
export function classifyRunEnd(args) {
  return args.outTimeSeconds >= args.expectedSeconds - args.toleranceSeconds ? "pass_end" : "early_end";
}

/** §3.6: the waits before restarting the encoder after consecutive exits. */
export const RESTART_BACKOFF_SECONDS = Object.freeze([2, 4, 8, 16, 32, 60]);
/** A run that lasted at least this long resets the backoff. */
export const BACKOFF_RESET_AFTER_SECONDS = 600;

/**
 * The wait before the next start after `consecutiveFailures` failed runs in a row (0 = the first failure).
 * @param {number} consecutiveFailures
 * @returns {number}
 */
export function restartDelaySeconds(consecutiveFailures) {
  return RESTART_BACKOFF_SECONDS[Math.min(Math.max(0, consecutiveFailures), RESTART_BACKOFF_SECONDS.length - 1)];
}

/**
 * §3.7: removes the stream key, and any rtmp(s):// path after the host, from a line before it reaches any log, status,
 * event, report or error. ffmpeg prints the full output URL in its banner and in "Error opening output" lines (§6.1).
 * @param {string} text
 * @param {readonly string[]} secrets
 * @returns {string}
 */
export function scrubSecrets(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[key]");
  }
  return out.replace(/(rtmps?:\/\/[^/\s'"]+)\/[^\s'"]*/gi, "$1/[path]");
}

/**
 * The encoder's ffmpeg arguments for one run (§3.6; flags fixed in spike A, §6.1): the concat list read at its native
 * rate, the first video and audio stream, the picture re-encoded to 30 fps H.264 with a keyframe every 2 s and no
 * B-frames, the sound copied, progress on stdout every 5 s, FLV to the ingest URL. The URL carries the key: it is in
 * ffmpeg's argv (RISK in TECHNICAL_DEBT) and never in a file this app writes.
 * @param {{ listPath: string; codec: "h264_videotoolbox" | "libx264"; bitrateKbps: number; outputUrl: string }} args
 * @returns {string[]}
 */
export function encoderArgs(args) {
  const rate = `${Math.round(args.bitrateKbps)}k`;
  const buffer = `${Math.round(args.bitrateKbps * 2)}k`;
  const video =
    args.codec === "libx264"
      ? ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-b:v", rate, "-minrate", rate, "-maxrate", rate, "-bufsize", buffer, "-x264-params", "nal-hrd=cbr:force-cfr=1", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-bf", "0"]
      : ["-c:v", "h264_videotoolbox", "-profile:v", "high", "-b:v", rate, "-maxrate", rate, "-bufsize", buffer, "-constant_bit_rate", "1", "-realtime", "1", "-g", "60", "-bf", "0"];
  return [
    "-hide_banner", "-nostdin", "-loglevel", "warning", "-nostats", "-stats_period", "5",
    "-re", "-f", "concat", "-safe", "0", "-i", args.listPath,
    "-map", "0:v:0", "-map", "0:a:0",
    "-vf", "fps=30", "-pix_fmt", "yuv420p",
    ...video,
    "-c:a", "copy",
    "-progress", "pipe:1",
    "-flvflags", "no_duration_filesize",
    "-f", "flv", args.outputUrl,
  ];
}

/**
 * An ffconcat list for one run: the files in order, the first one starting at `inpoint` (a source keyframe).
 * @param {readonly string[]} files
 * @param {number} inpoint
 * @returns {string}
 */
export function concatList(files, inpoint) {
  const lines = ["ffconcat version 1.0"];
  files.forEach((file, i) => {
    lines.push(`file '${String(file).replace(/'/g, "'\\''")}'`);
    if (i === 0 && inpoint > 0) lines.push(`inpoint ${inpoint.toFixed(6)}`);
  });
  return `${lines.join("\n")}\n`;
}
