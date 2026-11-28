import path from "node:path";
import { earliestDecidingRecord } from "@/lib/review-items";
import type { ClipReviewAttachment, ClipReviewClip, ClipReviewDecision, ClipReviewStatus, ClipReviewView, ClipSourceFile } from "./contracts";
import { CLIP_VIDEO_TYPES } from "./contracts";

// BL-241 (ADR 0061 §5): pure rules. The status is derived from the decisions, never stored, so two computers' documents merge
// without a conflict and read the same answer.

/**
 * The record that decides a clip: the EARLIEST owner decision (by time, then id); without one, the earliest Producer withdrawal;
 * null while pending. A later owner decision made offline on the other computer is kept in the document but does not count.
 * BL-272 (ADR 0076): the rule itself is the shared `review-items` one (the master still images use it too).
 */
export function decidingRecordOf(clipId: string, decisions: readonly ClipReviewDecision[]): ClipReviewDecision | null {
  return earliestDecidingRecord(
    decisions.filter((d) => d.clipId === clipId),
    ["approved", "returned"]
  );
}

export function statusOf(record: ClipReviewDecision | null): ClipReviewStatus {
  return record ? record.kind : "pending";
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * BL-280 (FO-REQ-0062 B): the clip's submitted file as its stored record names it. The record comes from either computer's document
 * (no schema on read), so each field is taken only when it is the expected shape; otherwise null -- never derived from anything else.
 */
export function clipSourceOf(clip: ClipReviewClip): ClipSourceFile {
  const record = clip as Partial<Record<keyof ClipReviewClip, unknown>>;
  return {
    clipId: clip.clipId,
    file: typeof record.clipPath === "string" && record.clipPath.length > 0 ? record.clipPath : null,
    sha256: typeof record.sha256 === "string" && SHA256_HEX.test(record.sha256) ? record.sha256 : null,
    submittedAt: typeof record.submittedAt === "string" && record.submittedAt.length > 0 ? record.submittedAt : null,
  };
}

export function clipViewOf(clip: ClipReviewClip, decisions: readonly ClipReviewDecision[]): ClipReviewView {
  const record = decidingRecordOf(clip.clipId, decisions);
  return {
    clipId: clip.clipId,
    channelId: clip.channelId,
    sceneId: clip.sceneId,
    clipPath: clip.clipPath,
    note: clip.note,
    startSec: clip.startSec,
    endSec: clip.endSec,
    durationSeconds: clip.durationSeconds,
    sizeBytes: clip.sizeBytes,
    sha256: clip.sha256,
    submittedAt: clip.submittedAt,
    device: clip.device,
    status: statusOf(record),
    comment: record?.by === "owner" ? record.comment : null,
    decidedAt: record?.at ?? null,
    decidedOn: record?.device ?? null,
    // BL-246: only an owner decision carries files; a decision stored without the field (older builds) reads [].
    attachments: record?.by === "owner" ? wellFormedAttachments(record.attachments) : [],
    // BL-272 (ADR 0076): only a clip that names its approved source image carries the key.
    ...(typeof clip.approvedImageId === "string" ? { approvedImageId: clip.approvedImageId } : {}),
    source: clipSourceOf(clip),
  };
}

/**
 * BL-246 (review): the attachments of a record as the other computer's document carries them -- an entry that is not the expected
 * shape is skipped (never thrown on, which would break the whole channel's list); a field that is not a list reads [].
 */
export function wellFormedAttachments(value: unknown): ClipReviewAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: ClipReviewAttachment[] = [];
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const a = entry as Record<string, unknown>;
    if (typeof a.path !== "string" || typeof a.name !== "string" || typeof a.mime !== "string" || typeof a.sha256 !== "string") continue;
    if (typeof a.size !== "number" || !Number.isSafeInteger(a.size) || a.size < 0) continue;
    out.push({ path: a.path, name: a.name, mime: a.mime, size: a.size, sha256: a.sha256 });
  }
  return out;
}

/** Pending first, oldest first (the queue); then the rest, newest first. */
export function sortClipViews<T extends Pick<ClipReviewView, "status" | "submittedAt" | "clipId">>(views: readonly T[]): T[] {
  // BL-280 (review): a synced record may lack `submittedAt`; it sorts as "" instead of throwing (which broke every list and submit).
  const at = (v: T) => String(v.submittedAt ?? "");
  const pending = views.filter((v) => v.status === "pending").sort((a, b) => at(a).localeCompare(at(b)) || a.clipId.localeCompare(b.clipId));
  const rest = views.filter((v) => v.status !== "pending").sort((a, b) => at(b).localeCompare(at(a)) || a.clipId.localeCompare(b.clipId));
  return [...pending, ...rest];
}

/** The browser type of a clip's file by its extension, or null for anything that is not an allowed video. */
export function clipVideoTypeOf(filePath: string): string | null {
  return CLIP_VIDEO_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

/** Whether a measured duration is a clip's length (5-300 s, with the tolerance). */
export function durationAccepted(seconds: number, limits: { minSeconds: number; maxSeconds: number; toleranceSeconds: number }): boolean {
  return seconds >= limits.minSeconds - limits.toleranceSeconds && seconds <= limits.maxSeconds + limits.toleranceSeconds;
}
