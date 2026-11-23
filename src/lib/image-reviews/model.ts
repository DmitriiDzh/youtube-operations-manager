import path from "node:path";
import { earliestDecidingRecord } from "@/lib/review-items";
import { IMAGE_REVIEW_OWNER_KINDS } from "@/lib/sync-gateway";
import { IMAGE_FILE_TYPES, type ImageReviewDecision, type ImageReviewImage, type ImageReviewStatus, type ImageReviewView } from "./contracts";

// BL-272 (ADR 0076): pure rules. The status is derived from the decisions, never stored (ADR 0061 §5): the earliest owner decision
// counts, a Producer withdrawal only without one -- the shared `review-items` rule.

export function decidingImageRecordOf(imageId: string, decisions: readonly ImageReviewDecision[]): ImageReviewDecision | null {
  return earliestDecidingRecord(
    decisions.filter((d) => d.imageId === imageId),
    IMAGE_REVIEW_OWNER_KINDS
  );
}

export function imageViewOf(image: ImageReviewImage, decisions: readonly ImageReviewDecision[]): ImageReviewView {
  const record = decidingImageRecordOf(image.imageId, decisions);
  const status: ImageReviewStatus = record ? record.kind : "pending";
  return {
    imageId: image.imageId,
    channelId: image.channelId,
    sceneId: image.sceneId,
    imagePath: image.imagePath,
    note: image.note,
    batchId: image.batchId,
    requestId: image.requestId,
    width: image.width,
    height: image.height,
    sizeBytes: image.sizeBytes,
    sha256: image.sha256,
    submittedAt: image.submittedAt,
    device: image.device,
    status,
    comment: record?.by === "owner" ? record.comment : null,
    decidedAt: record?.at ?? null,
    decidedOn: record?.device ?? null,
  };
}

/** Pending first, oldest first (the queue); then the rest, newest first. */
export function sortImageViews<T extends Pick<ImageReviewView, "status" | "submittedAt" | "imageId">>(views: readonly T[]): T[] {
  const pending = views.filter((v) => v.status === "pending").sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.imageId.localeCompare(b.imageId));
  const rest = views.filter((v) => v.status !== "pending").sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || a.imageId.localeCompare(b.imageId));
  return [...pending, ...rest];
}

/** The image's kind by its extension (the format its header must have, the browser type), or null for anything else. */
export function imageFileTypeOf(filePath: string): { format: "png" | "jpeg"; type: string } | null {
  return IMAGE_FILE_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}
