// BL-272 (ADR 0076): the pure rules of Медиа → «Кадры» -- the image as the owner's route sends it, how images form batches (one
// grid per batch), which version of its scene an image is, and when each of the three answers can be sent. Kept apart from the
// panel so it is tested without a browser.

export type ImageStatus = "pending" | "approved" | "approved_with_note" | "returned" | "withdrawn";
export type ImageFileState = "ok" | "missing" | "changed";
export type ImageAction = "approve" | "approve_with_note" | "return";

export type ImageDto = {
  imageId: string;
  channelId: string;
  sceneId: string;
  imagePath: string;
  note: string;
  batchId: string | null;
  requestId: string | null;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  submittedAt: string;
  device: string | null;
  status: ImageStatus;
  comment: string | null;
  decidedAt: string | null;
  decidedOn: string | null;
  file: ImageFileState;
};

export type ImageBatch = {
  /** `b:<batchId>`, or `single` for the images sent without a batch. */
  key: string;
  batchId: string | null;
  /** In the order they were sent. */
  images: ImageDto[];
  waiting: number;
  /** When its newest image was sent (the batch order). */
  latestAt: string;
};

/**
 * One batch per `batchId` (the images without one together); batches with something waiting first, then the answered ones -- each
 * group newest first. Inside a batch the images keep the order they were sent in (the Producer's order).
 */
export function batchesOf(images: readonly ImageDto[]): ImageBatch[] {
  const byKey = new Map<string, ImageBatch>();
  for (const image of images) {
    const key = image.batchId === null ? "single" : `b:${image.batchId}`;
    const batch = byKey.get(key) ?? { key, batchId: image.batchId, images: [], waiting: 0, latestAt: "" };
    batch.images.push(image);
    if (image.status === "pending") batch.waiting += 1;
    if (image.submittedAt > batch.latestAt) batch.latestAt = image.submittedAt;
    byKey.set(key, batch);
  }
  const batches = [...byKey.values()];
  for (const batch of batches) batch.images.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.imageId.localeCompare(b.imageId));
  const newestFirst = (a: ImageBatch, b: ImageBatch) => b.latestAt.localeCompare(a.latestAt) || a.key.localeCompare(b.key);
  return [...batches.filter((b) => b.waiting > 0).sort(newestFirst), ...batches.filter((b) => b.waiting === 0).sort(newestFirst)];
}

/** Each image's version within its scene: the first image sent for a scene is v1, a reworked one v2, ... (by the time it was sent). */
export function versionsOf(images: readonly ImageDto[]): Map<string, number> {
  const out = new Map<string, number>();
  const byScene = new Map<string, ImageDto[]>();
  for (const image of images) byScene.set(image.sceneId, [...(byScene.get(image.sceneId) ?? []), image]);
  for (const list of byScene.values()) {
    list.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.imageId.localeCompare(b.imageId));
    list.forEach((image, index) => out.set(image.imageId, index + 1));
  }
  return out;
}

/** An approval (with or without a note) needs the image to wait and this computer's copy to be the submitted file. */
export function canApprove(image: Pick<ImageDto, "status" | "file">): boolean {
  return image.status === "pending" && image.file === "ok";
}

/** Whether the answer can be sent: a plain approval needs no words; a note-approval and a return need some. */
export function answerReady(action: ImageAction, comment: string): boolean {
  return action === "approve" || comment.trim().length > 0;
}

export function previewSrcOf(base: string, image: Pick<ImageDto, "imageId" | "sha256">): string {
  // The SHA-256 in the address: a re-sent file under the same id never shows a cached old preview.
  return `${base}/${encodeURIComponent(image.imageId)}/preview?v=${image.sha256.slice(0, 12)}`;
}

export function fullSrcOf(base: string, image: Pick<ImageDto, "imageId" | "sha256">): string {
  return `${base}/${encodeURIComponent(image.imageId)}/image?v=${image.sha256.slice(0, 12)}`;
}
