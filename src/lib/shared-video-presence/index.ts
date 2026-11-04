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
