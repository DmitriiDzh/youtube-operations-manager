// ---------------------------------------------------------------------------
// BL-176 (LIVE_STREAMS_PLAN.md §3.6) -- the keyframe lookup that makes a resumed run start exactly at its `inpoint`.
// Plain JavaScript (JSDoc types): the live-stream encoder helper, a standalone node process, imports it as well as
// `ffmpeg-host/index.ts` -- one owner for the command and its parsing. No imports, no I/O.
// ---------------------------------------------------------------------------

/**
 * ffprobe arguments listing the keyframe times of the first video stream from `offsetSeconds - windowSeconds` to
 * `offsetSeconds` (inclusive).
 * @param {string} file
 * @param {number} offsetSeconds
 * @param {number} windowSeconds
 * @returns {string[]}
 */
export function keyframeProbeArgs(file, offsetSeconds, windowSeconds) {
  const from = Math.max(0, offsetSeconds - windowSeconds);
  return ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-read_intervals", `${from}%${offsetSeconds + 0.001}`, "-of", "csv=p=0", file];
}

/**
 * The greatest keyframe time at or before `offsetSeconds` from that command's output; `null` when there is none.
 * @param {string} csv
 * @param {number} offsetSeconds
 * @returns {number | null}
 */
export function pickKeyframeAtOrBefore(csv, offsetSeconds) {
  let best = null;
  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const t = Number(trimmed.split(",")[0]);
    if (!Number.isFinite(t)) continue;
    if (t <= offsetSeconds + 1e-6 && (best === null || t > best)) best = t;
  }
  return best;
}
