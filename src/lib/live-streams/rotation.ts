// ---------------------------------------------------------------------------
// BL-176 (docs/roadmap/plans/LIVE_STREAMS_PLAN.md, ADR 0036) -- the rotation's pure rules: the public-only guard,
// where playback is from the encoder's `out_time`, how a run ended, what the buffer holds, and whether a copy fits.
// No I/O; the services and the encoder helper call these.
// ---------------------------------------------------------------------------

export type GuardRefusal = "private" | "unlisted" | "scheduled" | "unknown" | "not_found";
export type GuardResult = { allowed: true } | { allowed: false; reason: GuardRefusal };

/**
 * §3.4: a video may enter and stay in a rotation only if YouTube says it is `public` and it has no future
 * `publishAt`. A video with a future `publishAt` is "scheduled" whatever its current privacy. `null` = YouTube did not
 * return the video.
 */
export function checkPublicOnly(
  video: { privacyStatus: string | null; publishAt: string | null } | null,
  now: Date
): GuardResult {
  if (!video) return { allowed: false, reason: "not_found" };
  if (video.publishAt) {
    const at = Date.parse(video.publishAt);
    if (!Number.isFinite(at)) return { allowed: false, reason: "unknown" };
    if (at > now.getTime()) return { allowed: false, reason: "scheduled" };
  }
  if (video.privacyStatus === "public") return { allowed: true };
  if (video.privacyStatus === "private" || video.privacyStatus === "unlisted") return { allowed: false, reason: video.privacyStatus };
  return { allowed: false, reason: "unknown" };
}

// The playback rules (where a run is, how it ended) are shared with the encoder helper, a standalone node process; their
// one owner is `playback.mjs`.
export { classifyRunEnd, locatePlayback, passLength } from "./playback.mjs";

/**
 * §3.5: the buffer holds the video now playing and the next `depth - 1` of the pass (continuing into the next pass,
 * whose first video is `nextPassFirst`). `copy` = wanted but not present, in the order they are needed; `remove` =
 * present but no longer wanted. The video now playing is always kept.
 */
export function planBuffer(args: {
  order: readonly string[];
  currentIndex: number;
  nextPassFirst: string | null;
  depth: number;
  present: readonly string[];
}): { keep: string[]; copy: string[]; remove: string[] } {
  const depth = Math.max(1, Math.floor(args.depth));
  const upcoming = [...args.order.slice(args.currentIndex), ...(args.nextPassFirst ? [args.nextPassFirst] : [])];
  const keep: string[] = [];
  for (const id of upcoming) {
    if (keep.length >= depth) break;
    if (!keep.includes(id)) keep.push(id);
  }
  const present = new Set(args.present);
  return {
    keep,
    copy: keep.filter((id) => !present.has(id)),
    remove: args.present.filter((id) => !keep.includes(id)),
  };
}

/** §3.5: a copy may start only if it leaves at least the refuse level free. */
export function canCopyIntoBuffer(args: { freeBytes: number; fileBytes: number; refuseBelowBytes: number }): boolean {
  return args.freeBytes - args.fileBytes >= args.refuseBelowBytes;
}

/**
 * §3.5: whether a copy of an original can stream as it is. The audio is copied into FLV unchanged, so it must be AAC at
 * 44.1/48 kHz with at most 2 channels; there must be a picture; and the file must be the YouTube video (duration within
 * 1 s). `null` = fine.
 */
export function checkOriginal(
  probe: {
    durationSeconds: number | null;
    video: { codec: string } | null;
    audio: { codec: string; sampleRate: number | null; channels: number | null } | null;
  },
  youtubeDurationSeconds: number | null,
  limits: { toleranceSeconds: number; sampleRates: readonly number[]; maxChannels: number }
): "no_video_stream" | "audio_unsupported" | "duration_unknown" | "duration_mismatch" | null {
  if (!probe.video) return "no_video_stream";
  const audio = probe.audio;
  if (!audio || audio.codec !== "aac" || audio.sampleRate === null || !limits.sampleRates.includes(audio.sampleRate)) return "audio_unsupported";
  if (audio.channels === null || audio.channels < 1 || audio.channels > limits.maxChannels) return "audio_unsupported";
  if (probe.durationSeconds === null || youtubeDurationSeconds === null) return "duration_unknown";
  return Math.abs(probe.durationSeconds - youtubeDurationSeconds) <= limits.toleranceSeconds ? null : "duration_mismatch";
}
