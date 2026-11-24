import { IMAGE_REVIEW_OWNER_KINDS, type ImageReviewDecision, type ImageReviewImage, type ImageReviewsSnapshot, type ImageReviewDecisionKind } from "@/lib/sync-gateway";
import { earliestDecidingRecord } from "./rules";

// BL-272 (review, ADR 0076 §2/§6): the ONE owner of "what status has this master still" -- the image-reviews module (its views, the
// Producer's tools, the owner's tab) and the clips' source-image link (clip-reviews' `imageOf` port) both derive it here, from the
// synced `image_reviews` document, with the shared deciding rule. Neither review module imports the other (AGENTS.md §M).

export type ImageReviewStatus = ImageReviewDecisionKind | "pending";

/** The record that decides an image: the earliest owner decision (approved, approved_with_note, returned), else a withdrawal. */
export function decidingImageRecord(imageId: string, decisions: readonly ImageReviewDecision[]): ImageReviewDecision | null {
  return earliestDecidingRecord(
    decisions.filter((d) => d.imageId === imageId),
    IMAGE_REVIEW_OWNER_KINDS
  );
}

/** An image's status from its deciding record (`pending` without one). */
export function imageStatusFrom(record: Pick<ImageReviewDecision, "kind"> | null): ImageReviewStatus {
  return record ? record.kind : "pending";
}

/**
 * An image of `channelId` in that channel's document with its deciding record and status; null when the document has no such image
 * or the record names another channel (a channel's image is never another's).
 */
export function imageReviewStateOf(snapshot: ImageReviewsSnapshot, channelId: string, imageId: string): { image: ImageReviewImage; record: ImageReviewDecision | null; status: ImageReviewStatus } | null {
  const image = Object.hasOwn(snapshot.images, imageId) ? snapshot.images[imageId] : undefined;
  if (!image || image.channelId !== channelId) return null;
  const record = decidingImageRecord(imageId, Object.values(snapshot.decisions));
  return { image, record, status: imageStatusFrom(record) };
}
