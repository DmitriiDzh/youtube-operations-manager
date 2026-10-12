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

/** Seconds a run plays from `startIndex` at `startOffset` to the end of the list. */
export function passLength(durations: readonly number[], startIndex: number, startOffset: number): number {
  return durations.slice(startIndex).reduce((sum, d) => sum + d, 0) - startOffset;
}

/**
 * Which video plays, and where in it, `outTimeSeconds` into a run that started at `startIndex` / `startOffset`.
 * The run's `inpoint` is a source keyframe, so the run starts exactly there (§3.6).
 */
export function locatePlayback(
  durations: readonly number[],
  start: { startIndex: number; startOffset: number },
  outTimeSeconds: number
): { index: number; offset: number; passEnded: boolean } {
  let index = start.startIndex;
  let offset = start.startOffset + Math.max(0, outTimeSeconds);
  while (index < durations.length && offset >= durations[index]) {
    offset -= durations[index];
    index += 1;
  }
  if (index >= durations.length) return { index: durations.length, offset: 0, passEnded: true };
  return { index, offset: roundMs(offset), passEnded: false };
}

function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * §3.6: ffmpeg exits with code 0 both at the end of its list and when a listed file is missing, so the exit code
 * cannot tell them apart. A run is a pass end only if it played (within the tolerance) as long as its list.
 */
export function classifyRunEnd(args: { outTimeSeconds: number; expectedSeconds: number; toleranceSeconds: number }): "pass_end" | "early_end" {
  return args.outTimeSeconds >= args.expectedSeconds - args.toleranceSeconds ? "pass_end" : "early_end";
}

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
