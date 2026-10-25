import { DomainError } from "@/lib/shared-domain";

/**
 * How close to now a publish time may be when it is written or replaced: inside this margin YouTube may publish the video between
 * our fresh read and the write, and the write (which resends `privacyStatus: private`) would take it back to private (BL-182 review).
 */
export const PUBLISH_AT_MARGIN_MS = 15 * 60_000;

/**
 * When `status.publishAt` may be written (BL-182 stage 1, owner msg 2707: "rescheduling while private: yes"; YouTube Data API videos
 * reference: publishAt can be set only on a private video, which becomes public at that time -- a past time publishes it at once):
 * - only on a video that is private now (a public or unlisted one is refused, whether or not it ever had a date);
 * - if it already has a date, only while that date is more than the margin ahead (the video is not published or publishing);
 * - the new date must be more than the margin ahead.
 * One rule for the preview and for the write (the adapter re-checks against its own fresh read).
 */
export function publishAtWriteRefusal(
  videoId: string,
  before: { privacyStatus: string | null; publishAt: string | null },
  patch: { publishAt?: string | null },
  nowMs: number
): DomainError | null {
  if (patch.publishAt === undefined) return null;
  const currentMs = before.publishAt ? Date.parse(before.publishAt) : null;
  if (before.privacyStatus !== "private" || (currentMs !== null && (Number.isNaN(currentMs) || currentMs <= nowMs + PUBLISH_AT_MARGIN_MS))) {
    return new DomainError({
      code: "publish_at_already_published",
      message: "publishAt can only be set while the video is private and any current publish time is more than 15 minutes ahead",
      details: { videoId, currentPublishAt: before.publishAt, privacyStatus: before.privacyStatus },
    });
  }
  // BL-225 stage 3 (ADR 0051): removing the date (a vetoed slot) needs only the rule above -- the video stays private.
  if (patch.publishAt === null) return null;
  const nextMs = Date.parse(patch.publishAt);
  if (Number.isNaN(nextMs) || nextMs <= nowMs + PUBLISH_AT_MARGIN_MS) {
    return new DomainError({
      code: "publish_at_too_soon",
      message: "A publish time must be more than 15 minutes in the future (a past time would publish the video at once)",
      details: { videoId, publishAt: patch.publishAt },
    });
  }
  return null;
}

/** Whether the Details card offers the publish-time field: the same rule, without a new value yet. */
export function canWritePublishAt(video: { privacyStatus: string | null; publishAt: string | null }, nowMs: number): boolean {
  if (video.privacyStatus !== "private") return false;
  if (!video.publishAt) return true;
  const currentMs = Date.parse(video.publishAt);
  return !Number.isNaN(currentMs) && currentMs > nowMs + PUBLISH_AT_MARGIN_MS;
}
