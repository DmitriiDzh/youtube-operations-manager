// BL-243 (ADR 0063; AGENTS.md §M): the one name and the one rules for "the channel sync found this uploaded video removed on
// YouTube", shared by the package scan (`publishing`), the weekly plan (`publishing-plans`), the plan progress, the video list
// (`video-projects`) and the plan screen. Pure and dependency-free, so a client component can import it too.

/** The problem code of a package, and the `failed` status code of a plan slot, whose uploaded video was deleted on YouTube. */
export const VIDEO_DELETED_ON_YOUTUBE = "video_deleted_on_youtube";

/** A plan slot's progress (its status and code) says its only package names a video deleted on YouTube. */
export function isDeletedOnYoutube(progress: { status: string; code?: string | null } | null | undefined): boolean {
  return progress?.status === "failed" && progress.code === VIDEO_DELETED_ON_YOUTUBE;
}

/**
 * Whether an uploaded video is on the channel, as the local copy can say (ADR 0063 §1): false -- the sync marked it removed (proof
 * on its own); true -- the copy lists it and a completed removed check (`checkedAt`) could have seen it: YouTube's `publishedAt`
 * not later than the check (the copy keeps no "first seen" time; for a video made public after the check `publishedAt` is its
 * publish time, so it reads null until the next completed check -- unknown, never wrong); null -- anything else (unknown).
 */
export function existsOnChannelOf(args: { removed: boolean; listed: boolean; publishedAt?: string | null; checkedAt: string | null }): boolean | null {
  if (args.removed) return false;
  if (!args.listed || !args.publishedAt || !args.checkedAt) return null;
  const published = Date.parse(args.publishedAt);
  const checked = Date.parse(args.checkedAt);
  return Number.isFinite(published) && Number.isFinite(checked) && published <= checked ? true : null;
}

/**
 * BL-243 review round 7 (ADR 0063 §2): how much newer than an upload a removed mark must be before it lets a SECOND upload of
 * that upload's plan slot be queued. A fresh private upload can be missing from a lagging uploads playlist, so a sync right after
 * it may mark it removed by mistake; within this time the mark never frees a slot for another upload. Display is not affected.
 */
export const REMOVED_MARK_GRACE_MS = 24 * 60 * 60 * 1000;

/** The removed mark may free the upload's slot for another upload: it is at least `REMOVED_MARK_GRACE_MS` newer. Unknown: no. */
export function removedMarkFreesSlot(args: { removedAt: string | Date | null | undefined; uploadedAt: string | Date | null | undefined }): boolean {
  const removed = args.removedAt ? new Date(args.removedAt).getTime() : NaN;
  const uploaded = args.uploadedAt ? new Date(args.uploadedAt).getTime() : NaN;
  return Number.isFinite(removed) && Number.isFinite(uploaded) && removed - uploaded >= REMOVED_MARK_GRACE_MS;
}
