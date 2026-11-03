import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-241 (ADR 0061, docs/roadmap/plans/CLIP_REVIEWS_PLAN.md): a channel's clips for review, the same on every computer. One
// Automerge document per channel. The Producer submits and withdraws on whichever computer its endpoint reaches; the owner decides on
// either. Clips and decisions are two flat maps that exist from the genesis, so two computers that each add a clip or a decision
// merge instead of one replacing the other: a clip is assigned whole once under its id and never edited, a decision under a fresh
// id. The status is derived from the decisions by the clip-reviews module; this family stores and carries.

/** One submitted clip: a file already in the channel folder, named relative to the workspace root (never an absolute path). */
export type ClipReviewClip = {
  clipId: string;
  channelId: string;
  sceneId: string;
  /** Relative to the channel workspace root, `/` between folders. */
  clipPath: string;
  note: string;
  startSec: number | null;
  endSec: number | null;
  durationSeconds: number;
  sizeBytes: number;
  sha256: string;
  submittedAt: string;
  /** The Producer token that submitted it. */
  submittedBy: string;
  /** The computer it was submitted on (host name), or null. */
  device: string | null;
};

export type ClipReviewDecisionKind = "approved" | "returned" | "withdrawn";

/** A decision on one clip; never edited. The owner approves or returns, the Producer withdraws. */
export type ClipReviewDecision = {
  id: string;
  clipId: string;
  kind: ClipReviewDecisionKind;
  by: "owner" | "producer";
  comment: string | null;
  device: string | null;
  at: string;
};

export type ClipReviewsDocument = {
  format: "ytm-clip-reviews";
  version: 1;
  channelId: string;
  /** By clip id. */
  clips: Record<string, ClipReviewClip>;
  /** By decision id. */
  decisions: Record<string, ClipReviewDecision>;
};

/** The whole document as plain data (empty maps for a channel without a document yet). */
export type ClipReviewsSnapshot = Pick<ClipReviewsDocument, "clips" | "decisions">;

export type MergeResult = { newConflicts: [] };
