// BL-243 (ADR 0063; AGENTS.md §M): the one name for "the channel sync found this uploaded video removed on YouTube", shared by
// the package scan (`publishing`), the weekly plan (`publishing-plans`), the plan progress and the plan screen. Pure and
// dependency-free, so a client component can import it too.

/** The problem code of a package, and the `failed` status code of a plan slot, whose uploaded video was deleted on YouTube. */
export const VIDEO_DELETED_ON_YOUTUBE = "video_deleted_on_youtube";

/** A plan slot's status and code say its only package names a video deleted on YouTube. */
export function isDeletedOnYoutubeStatus(status: string, code: string | null | undefined): boolean {
  return status === "failed" && code === VIDEO_DELETED_ON_YOUTUBE;
}
