// BL-241 (CLIP_REVIEWS_PLAN.md item 5, ADR 0061 §6): the pure rules of Контент → «Клипы» -- the clip as the owner's route sends it,
// where the player starts and stops, and when «Одобрить» is possible. Kept apart from the panel so it is tested without a browser.

export type ClipStatus = "pending" | "approved" | "returned" | "withdrawn";
export type ClipFileState = "ok" | "missing" | "changed";

export type ClipDto = {
  clipId: string;
  channelId: string;
  sceneId: string;
  clipPath: string;
  note: string;
  startSec: number | null;
  endSec: number | null;
  durationSeconds: number;
  sizeBytes: number;
  submittedAt: string;
  device: string | null;
  status: ClipStatus;
  comment: string | null;
  decidedAt: string | null;
  decidedOn: string | null;
  file: ClipFileState;
};

/** `m:ss` of a number of seconds (rounded down to the second): 65.4 -> "1:05", 120 -> "2:00". */
export function clockOf(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The part the Producer asked to watch, as `start – end` on the clip's clock; null when the whole clip is meant. */
export function rangeOf(clip: Pick<ClipDto, "startSec" | "endSec" | "durationSeconds">): { from: string; to: string } | null {
  if (clip.startSec === null && clip.endSec === null) return null;
  return { from: clockOf(clip.startSec ?? 0), to: clockOf(clip.endSec ?? clip.durationSeconds) };
}

/**
 * The player's address: this computer's copy through the owner's route, with a media fragment (`#t=start,end`, W3C Media Fragments)
 * so the browser starts at the range and pauses at its end.
 */
export function videoSrcOf(base: string, clip: Pick<ClipDto, "clipId" | "startSec" | "endSec">): string {
  const url = `${base}/${encodeURIComponent(clip.clipId)}/video`;
  if (clip.startSec === null && clip.endSec === null) return url;
  const start = clip.startSec ?? 0;
  return clip.endSec === null ? `${url}#t=${start}` : `${url}#t=${start},${clip.endSec}`;
}

/** «Одобрить» needs a waiting clip whose file here is the submitted one; «Вернуть» only a waiting clip. */
export function canApprove(clip: Pick<ClipDto, "status" | "file">): boolean {
  return clip.status === "pending" && clip.file === "ok";
}

/** Whether a return comment can be sent (it is required: what to change). */
export function returnCommentReady(text: string): boolean {
  return text.trim().length > 0 && text.length <= 2000;
}
