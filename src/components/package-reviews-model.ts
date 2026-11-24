// BL-257 (ADR 0070, PACKAGE_REVIEW_PLAN.md stage 2): the review screen's pure helpers (tested on their own).

import { roundSeconds, TIMED_COMMENT_LIMITS, type DraftTimedComment, type TimedComment } from "@/lib/package-reviews/timed-comments";

export type PackageReviewState = "pending" | "approved" | "returned" | "uploaded";

/** One package as `GET /api/channels/<id>/package-reviews` answers it (`@/lib/package-reviews` PackageReviewItem). */
export type PackageReviewDto = {
  manifestSha256: string;
  manifestPath: string;
  video: string;
  title: string;
  description: string;
  languages: string[];
  slotId: string | null;
  plannedPublishDate: string | null;
  durationSeconds: number;
  thumbnailPath: string | null;
  state: PackageReviewState;
  decision: "approved" | "returned" | null;
  comment: string | null;
  /** Owner TG 4817 (AC-TC-09): the standing decision's timed comments (absent from an older server). */
  timedComments?: TimedComment[];
  decidedAt: string | null;
  decidedOn: string | null;
  hasVideoSha256: boolean;
  otherProblems: string[];
  /** BL-265 (ADR 0072 §2): the owner's packaging comments on this video, newest first (never part of the gate). */
  packagingComments?: Array<{ id: string; comment: string; at: string; device: string | null }>;
  /** BL-265: the YouTube video id once uploaded, else null. */
  videoId?: string | null;
};

export type PackageReviewsDto = {
  channelId: string;
  required: boolean;
  requiredUpdatedAt: string | null;
  readable: boolean;
  packages: "ok" | "no_workspace" | "workspace_unavailable";
  items: PackageReviewDto[];
  waiting: number;
};

/** The package's own video or thumbnail, by its manifest hash -- never a path (the route finds the file itself). */
export function mediaSrcOf(base: string, manifestSha256: string, which: "video" | "thumbnail"): string {
  return `${base}/${which}?manifest=${encodeURIComponent(manifestSha256)}`;
}

/** `58` -> `0:58`, `754` -> `12:34`, `3725` -> `1:02:05`. */
export function durationLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * Which actions a package offers: the owner may change his mind about the video until the upload; approval needs the video's
 * checksum. BL-265 (ADR 0072 §2, AC-MG-07): a packaging comment is offered on every package, uploaded ones included.
 */
export function actionsOf(item: Pick<PackageReviewDto, "state" | "hasVideoSha256">): { approve: boolean; ret: boolean; comment: boolean } {
  if (item.state === "uploaded") return { approve: false, ret: false, comment: true };
  return { approve: item.state !== "approved" && item.hasVideoSha256, ret: item.state !== "returned", comment: true };
}

/** A return (and a packaging comment) needs a comment with at least one character that is not a space. */
export function returnCommentReady(comment: string): boolean {
  return comment.trim().length > 0;
}

/** The player's frame from the video's own size: vertical (Shorts, 9:16) or the 16:9 default until the metadata is known. */
export function frameOf(width: number, height: number): "vertical" | "horizontal" {
  return width > 0 && height > width ? "vertical" : "horizontal";
}

// --- Owner TG 4817 (PACKAGE_REVIEW_PLAN.md AC-TC-01..09): timed comments -----------------------------------------------------

/** `GET/PUT …/package-reviews/draft` (`@/lib/package-reviews` PackageReviewDraft). */
export type PackageReviewDraftDto = { manifestSha256: string; comments: DraftTimedComment[]; updatedAt: string | null };

/** The draft's place on the screen: loaded and saved, being saved, or not saved (the screen offers to try again). */
export type DraftSaveState = "loading" | "saved" | "saving" | "error";

/** A new comment's id (the screen's; letters and digits, as the server accepts). */
export function newCommentId(random: () => number = Math.random): string {
  return `c${Date.now().toString(36)}${Math.floor(random() * 1e9).toString(36)}`.slice(0, 40);
}

/** The draft with one more comment at `atSeconds` (one decimal), kept in time order; an empty text adds nothing. */
export function withComment(list: readonly DraftTimedComment[], comment: DraftTimedComment): DraftTimedComment[] {
  const text = comment.text.trim();
  if (!text || list.length >= TIMED_COMMENT_LIMITS.count) return [...list];
  return [...list, { id: comment.id, atSeconds: roundSeconds(Math.max(0, comment.atSeconds)), text: text.slice(0, TIMED_COMMENT_LIMITS.text) }].sort((a, b) => a.atSeconds - b.atSeconds);
}

/** The draft with one comment's text changed; an empty text leaves it as it was (deleting is its own action). */
export function withEditedComment(list: readonly DraftTimedComment[], id: string, text: string): DraftTimedComment[] {
  const trimmed = text.trim();
  return list.map((c) => (c.id === id && trimmed ? { ...c, text: trimmed.slice(0, TIMED_COMMENT_LIMITS.text) } : c));
}

export function withoutComment(list: readonly DraftTimedComment[], id: string): DraftTimedComment[] {
  return list.filter((c) => c.id !== id);
}

/** Line breaks become spaces as he types (a timed comment is one line). */
export const oneLineText = (value: string) => value.replace(/[\r\n\t]+/g, " ");

/**
 * Whether a decision can be sent (AC-TC-06): an approval always; a return with a general comment or at least one timed comment; a
 * packaging comment with its comment.
 */
export function decisionReady(kind: "approved" | "returned" | "packaging_comment", comment: string, timedCount: number): boolean {
  if (kind === "approved") return true;
  if (kind === "returned") return comment.trim().length > 0 || timedCount > 0;
  return comment.trim().length > 0;
}

/** The decision's body: the draft's comments go with an approval or a return only, without the screen's ids (AC-TC-05). */
export function decisionBody(manifestSha256: string, kind: "approved" | "returned" | "packaging_comment", comment: string, draft: readonly DraftTimedComment[]) {
  return {
    manifestSha256,
    kind,
    comment: comment.trim() || null,
    ...(kind !== "packaging_comment" && draft.length > 0 ? { timedComments: draft.map((c) => ({ atSeconds: c.atSeconds, text: c.text })) } : {}),
  };
}
