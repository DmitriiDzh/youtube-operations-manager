import { DomainError } from "@/lib/shared-domain";

/**
 * When `status.publishAt` may be written (BL-182 stage 1, owner msg 2707: "rescheduling while private: yes"; YouTube Data API videos
 * reference: publishAt can be set only on a private video, which becomes public at that time).
 * - A video without a date: as before (private only, enforced by the patch schema).
 * - A video with a date: only while it is still private AND that date is still ahead -- then the new date must be ahead too, or
 *   YouTube would publish it at once. Once the date has passed (the video is published or publishing), it is refused.
 * One rule for the preview and for the write (the adapter re-checks against its own fresh read).
 */
export function publishAtWriteRefusal(
  videoId: string,
  before: { privacyStatus: string | null; publishAt: string | null },
  patch: { publishAt?: string },
  nowMs: number
): DomainError | null {
  if (patch.publishAt === undefined || !before.publishAt) return null;
  const currentMs = Date.parse(before.publishAt);
  if (before.privacyStatus !== "private" || Number.isNaN(currentMs) || currentMs <= nowMs) {
    return new DomainError({
      code: "publish_at_already_published",
      message: "publishAt can only be changed while the video is still private and its current publish time is still ahead",
      details: { videoId, currentPublishAt: before.publishAt },
    });
  }
  const nextMs = Date.parse(patch.publishAt);
  if (Number.isNaN(nextMs) || nextMs <= nowMs) {
    return new DomainError({
      code: "validation_failed",
      message: "A new publish time must be in the future (a past time would publish the video at once)",
      details: { videoId, publishAt: patch.publishAt },
    });
  }
  return null;
}
