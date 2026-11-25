// BL-257 (ADR 0070, PACKAGE_REVIEW_PLAN.md stage 2): the review screen's pure helpers (tested on their own).

import type { IssueCounts, ReviewIssue } from "@/lib/package-reviews/issues";
import { roundSeconds, TIMED_COMMENT_LIMITS, type DraftTimedComment, type IssueAction, type TimedComment } from "@/lib/package-reviews/timed-comments";

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
  /** Owner TG 4846 (AC-IS-06): the video's issues across its package versions and their counts (absent from an older server). */
  issues?: ReviewIssue[];
  issueCounts?: IssueCounts;
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
export function actionsOf(item: Pick<PackageReviewDto, "state" | "hasVideoSha256">): { approve: boolean; reapprove: boolean; ret: boolean; comment: boolean } {
  if (item.state === "uploaded") return { approve: false, reapprove: false, ret: false, comment: true };
  // Owner TG 4836: an approved video can be approved again WITH NOTES for future videos (a new approval; it stays approved).
  return { approve: item.state !== "approved" && item.hasVideoSha256, reapprove: item.state === "approved" && item.hasVideoSha256, ret: item.state !== "returned", comment: true };
}

/** A return (and a packaging comment) needs a comment with at least one character that is not a space. */
export function returnCommentReady(comment: string): boolean {
  return comment.trim().length > 0;
}


// --- Owner TG 4817 (PACKAGE_REVIEW_PLAN.md AC-TC-01..09): timed comments -----------------------------------------------------

/** `GET/PUT …/package-reviews/draft` (`@/lib/package-reviews` PackageReviewDraft). */
export type PackageReviewDraftDto = { manifestSha256: string; comments: DraftTimedComment[]; issueActions?: IssueAction[]; updatedAt: string | null };

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
export function decisionReady(kind: "approved" | "returned" | "packaging_comment", comment: string, timedCount: number, reapprove = false): boolean {
  // Owner TG 4836: approving an approved video again only makes sense with notes (a general comment or comments at moments).
  if (kind === "approved") return !reapprove || comment.trim().length > 0 || timedCount > 0;
  if (kind === "returned") return comment.trim().length > 0 || timedCount > 0;
  return comment.trim().length > 0;
}

/** The decision's body: the draft's comments go with an approval or a return only, without the screen's ids (AC-TC-05). */
export function decisionBody(manifestSha256: string, kind: "approved" | "returned" | "packaging_comment", comment: string, draft: readonly DraftTimedComment[], draftUpdatedAt: string | null = null, issueActions: readonly IssueAction[] = []) {
  return {
    manifestSha256,
    kind,
    comment: comment.trim() || null,
    ...(kind !== "packaging_comment" && draft.length > 0 ? { timedComments: draft.map((c) => ({ atSeconds: c.atSeconds, text: c.text })) } : {}),
    // Review fix 1: the draft this decision was made from (its server stamp; null: none) -- the server deletes only that one.
    ...(kind !== "packaging_comment" ? { draftUpdatedAt } : {}),
    // Owner TG 4846 (AC-IS-04): his actions on existing issues go with an approval or a return.
    ...(kind !== "packaging_comment" && issueActions.length > 0 ? { issueActions: issueActions.map((a) => (a.kind === "follow_up" ? { issueId: a.issueId, kind: a.kind, text: a.text ?? "" } : { issueId: a.issueId, kind: a.kind })) } : {}),
  };
}

/**
 * Review fix 3 (AC-TC-01): the moment a comment being written belongs to. Focusing the box with nothing typed takes the current moment
 * (the video pauses there); playing on or seeking drops a taken moment, so the comment never binds to an old one -- the next focus, or
 * adding it, takes the moment then.
 */
export function nextMoment(taken: number | null, event: { kind: "focus"; text: string; current: number } | { kind: "play" } | { kind: "seek" } | { kind: "retake"; current: number }): number | null {
  switch (event.kind) {
    case "focus":
      return taken === null || event.text.trim() === "" ? event.current : taken;
    case "retake":
      return event.current;
    default:
      return null;
  }
}

/** Owner TG 4846 (AC-IS-04): the draft's action on one issue set (one per issue: it replaces an earlier one), or removed. */
export function withIssueAction(list: readonly IssueAction[], action: IssueAction): IssueAction[] {
  const text = action.kind === "follow_up" ? oneLineText(action.text ?? "").trim().slice(0, TIMED_COMMENT_LIMITS.text) : undefined;
  if (action.kind === "follow_up" && !text) return [...list];
  return [...list.filter((a) => a.issueId !== action.issueId), action.kind === "follow_up" ? { issueId: action.issueId, kind: "follow_up", text } : { issueId: action.issueId, kind: "resolved" }];
}

export function withoutIssueAction(list: readonly IssueAction[], issueId: string): IssueAction[] {
  return list.filter((a) => a.issueId !== issueId);
}

/** What counts as notes / a reason with a decision: new timed comments and follow-ups (a resolve alone says nothing to change). */
export const notesCount = (comments: readonly unknown[], actions: readonly IssueAction[]) => comments.length + actions.filter((a) => a.kind === "follow_up").length;

/** Owner TG 4846: `I1`, `I2`... -- an issue's label on the timeline and in the list (new draft comments are 1, 2...). */
export const issueLabel = (index: number) => `I${index + 1}`;
