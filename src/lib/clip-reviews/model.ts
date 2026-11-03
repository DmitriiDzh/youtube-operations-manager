import path from "node:path";
import type { ClipReviewClip, ClipReviewDecision, ClipReviewStatus, ClipReviewView } from "./contracts";
import { CLIP_VIDEO_TYPES } from "./contracts";

// BL-241 (ADR 0061 §5): pure rules. The status is derived from the decisions, never stored, so two computers' documents merge
// without a conflict and read the same answer.

const byTimeThenId = (a: ClipReviewDecision, b: ClipReviewDecision) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);

/**
 * The record that decides a clip: the EARLIEST owner decision (by time, then id); without one, the earliest Producer withdrawal;
 * null while pending. A later owner decision made offline on the other computer is kept in the document but does not count.
 */
export function decidingRecordOf(clipId: string, decisions: readonly ClipReviewDecision[]): ClipReviewDecision | null {
  const own = decisions.filter((d) => d.clipId === clipId);
  const owner = own.filter((d) => d.by === "owner" && (d.kind === "approved" || d.kind === "returned")).sort(byTimeThenId);
  if (owner.length > 0) return owner[0];
  const withdrawn = own.filter((d) => d.by === "producer" && d.kind === "withdrawn").sort(byTimeThenId);
  return withdrawn[0] ?? null;
}

export function statusOf(record: ClipReviewDecision | null): ClipReviewStatus {
  return record ? record.kind : "pending";
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
  };
}

/** Pending first, oldest first (the queue); then the rest, newest first. */
export function sortClipViews<T extends Pick<ClipReviewView, "status" | "submittedAt" | "clipId">>(views: readonly T[]): T[] {
  const pending = views.filter((v) => v.status === "pending").sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.clipId.localeCompare(b.clipId));
  const rest = views.filter((v) => v.status !== "pending").sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || a.clipId.localeCompare(b.clipId));
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
