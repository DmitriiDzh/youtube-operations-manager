// BL-241 (CLIP_REVIEWS_PLAN.md item 5, ADR 0061 §6): the pure rules of Контент → «Клипы» -- the clip as the owner's route sends it,
// where the player starts and stops, and when «Одобрить» is possible. Kept apart from the panel so it is tested without a browser.

export type ClipStatus = "pending" | "approved" | "returned" | "withdrawn";
export type ClipFileState = "ok" | "missing" | "changed";

/** BL-246 (ADR 0065): one file the owner attached to his answer, as the owner's route sends it. */
export type ClipAttachmentDto = { index: number; path: string; name: string; mime: string; size: number; sha256: string; file: ClipFileState };

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
  /** BL-246: the deciding record's id (its attachments' folder), null while pending. */
  decisionId: string | null;
  attachments: ClipAttachmentDto[];
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

// ---- BL-246 (CLIP_REVIEWS_PLAN.md items 10, 13, 16): the comment's attachments ----

/** The address of one attachment through the owner's route (this computer's copy, loopback only). */
export function attachmentSrcOf(base: string, clipId: string, decisionId: string, index: number): string {
  return `${base}/${encodeURIComponent(clipId)}/attachments/${encodeURIComponent(decisionId)}/${index}`;
}

/** Shown as a picture (a thumbnail that opens the full size) rather than a link. */
export function isImageMime(mime: string): boolean {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime);
}

/** Where each piece of a file starts, `pieceBytes` apart: 10 bytes in pieces of 4 -> [0, 4, 8]; an empty file has none. */
export function pieceOffsetsOf(size: number, pieceBytes: number): number[] {
  const offsets: number[] = [];
  for (let offset = 0; offset < size; offset += pieceBytes) offsets.push(offset);
  return offsets;
}

export type ComposerItemState = "uploading" | "ready" | "failed";

/** The decision can be sent with its files: none uploading, none failed (a failed one is removed first). */
export function attachmentsReady(items: ReadonlyArray<{ state: ComposerItemState }>): boolean {
  return items.every((item) => item.state === "ready");
}

/** A whole percentage of a file sent (0..100). */
export function percentOf(sent: number, size: number): number {
  return size <= 0 ? 100 : Math.min(100, Math.floor((sent / size) * 100));
}

// ---- BL-247 (CLIP_REVIEWS_PLAN.md items 18-20, owner msgs 4085/4087): versions of a scene, newest on top ----

/** One version of a scene: the clip and its number (1 = the first submitted). */
export type ClipVersion = { clip: ClipDto; version: number };

/** One row of the screen: a scene, its latest version and the earlier ones (newest first). */
export type ClipScene = {
  sceneId: string;
  latest: ClipVersion;
  earlier: ClipVersion[];
  /** At least one version waits for the owner. */
  waiting: boolean;
};

/**
 * The screen's rows: the clips grouped by `sceneId` (exact match), versions numbered by `submittedAt` (the same moment by
 * `clipId`); waiting scenes first, then the others, each newest (by its latest version) on top.
 */
export function scenesOf(clips: readonly ClipDto[]): ClipScene[] {
  const bySubmission = (a: ClipDto, b: ClipDto) => a.submittedAt.localeCompare(b.submittedAt) || a.clipId.localeCompare(b.clipId);
  const groups = new Map<string, ClipDto[]>();
  for (const clip of clips) {
    const group = groups.get(clip.sceneId);
    if (group) group.push(clip);
    else groups.set(clip.sceneId, [clip]);
  }
  const scenes: ClipScene[] = [...groups].map(([sceneId, group]) => {
    const versions = [...group].sort(bySubmission).map((clip, i) => ({ clip, version: i + 1 }));
    const latest = versions[versions.length - 1];
    return { sceneId, latest, earlier: versions.slice(0, -1).reverse(), waiting: versions.some((v) => v.clip.status === "pending") };
  });
  return scenes.sort((a, b) => Number(b.waiting) - Number(a.waiting) || bySubmission(b.latest.clip, a.latest.clip));
}
