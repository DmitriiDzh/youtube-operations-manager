import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-272 (ADR 0076): a channel's master still images for review, the same on every computer -- the clip-reviews family's shape
// (ADR 0061 §1). One Automerge document per channel; images and decisions are two flat maps that exist from the genesis, so two
// computers that each add an image or a decision merge instead of one replacing the other: an image is assigned whole once under
// its id and never edited, a decision under a fresh id. The status is derived by the image-reviews module; this family stores.

/** One submitted image: a file already in the channel folder, named relative to the workspace root (never an absolute path). */
export type ImageReviewImage = {
  imageId: string;
  channelId: string;
  /** The scene the image is the master still of, e.g. "P46". */
  sceneId: string;
  /** Relative to the channel workspace root, `/` between folders. */
  imagePath: string;
  note: string;
  /** Several submits sharing one batch id are one batch (shown as one grid); null for a single image. */
  batchId: string | null;
  /** The Producer's idempotency key: a submit with a known one answers the stored image. */
  requestId: string | null;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  submittedAt: string;
  /** The Producer token that submitted it. */
  submittedBy: string;
  /** The computer it was submitted on (host name), or null. */
  device: string | null;
};

/** The owner approves, approves with a note (approved, and the note is to be applied) or returns; the Producer withdraws. */
export type ImageReviewDecisionKind = "approved" | "approved_with_note" | "returned" | "withdrawn";

/** A decision on one image; never edited. */
export type ImageReviewDecision = {
  id: string;
  imageId: string;
  kind: ImageReviewDecisionKind;
  by: "owner" | "producer";
  /** The owner's words: required for `approved_with_note` and `returned`, null on a plain approval and a withdrawal. */
  comment: string | null;
  device: string | null;
  at: string;
};

export type ImageReviewsDocument = {
  format: "ytm-image-reviews";
  version: 1;
  channelId: string;
  /** By image id. */
  images: Record<string, ImageReviewImage>;
  /** By decision id. */
  decisions: Record<string, ImageReviewDecision>;
};

/** The whole document as plain data (empty maps for a channel without a document yet). */
export type ImageReviewsSnapshot = Pick<ImageReviewsDocument, "images" | "decisions">;

export type MergeResult = { newConflicts: [] };

/** The owner's decision kinds (the earliest of these decides an image); a Producer withdrawal counts only without one. */
export const IMAGE_REVIEW_OWNER_KINDS: readonly ImageReviewDecisionKind[] = Object.freeze(["approved", "approved_with_note", "returned"]);
/** The kinds that make an image approved (a clip may name it as its source: `approvedImageId`). */
export const IMAGE_REVIEW_APPROVED_KINDS: readonly ImageReviewDecisionKind[] = Object.freeze(["approved", "approved_with_note"]);
