import { imageReviewStateOf } from "@/lib/review-items";
import type { ImageReviewsSnapshot } from "@/lib/sync-gateway";
import type { ClipSourceImage } from "../contracts";

// BL-272 (ADR 0076 §6; review): the clips' `imageOf` port -- a clip's source image read from the image reviews' synced document with
// the shared image status rule (`review-items.imageReviewStateOf`), never through the image-reviews feature module (AGENTS.md §M).
// `index.ts` passes the production family core; a test passes one over an in-memory store.

export function createClipSourceImageLookup(core: { read(channelId: string): Promise<ImageReviewsSnapshot> }): (channelId: string, imageId: string) => Promise<ClipSourceImage | null> {
  return async (channelId, imageId) => {
    const state = imageReviewStateOf(await core.read(channelId), channelId, imageId);
    return state ? { imageId, sceneId: state.image.sceneId, imagePath: state.image.imagePath, status: state.status } : null;
  };
}
