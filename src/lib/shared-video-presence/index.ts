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
 * BL-243 (ADR 0063 §2): THE upload time of a video -- the record's `uploadedAt`, else the `uploadedAt` its upload row recorded (the
 * runner writes the same moment into both); null when neither says. The one rule the plan progress and the slot gate use.
 */
export function uploadTimeOf(record: { uploadedAt?: string | null } | null | undefined, row: { stepsJson: string } | null | undefined): number | null {
  const fromRecord = record?.uploadedAt ? Date.parse(record.uploadedAt) : NaN;
  if (Number.isFinite(fromRecord)) return fromRecord;
  if (!row) return null;
  try {
    const at = Date.parse(String((JSON.parse(row.stepsJson) as { uploadedAt?: unknown }).uploadedAt ?? ""));
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * BL-243 (ADR 0063 §2, review round 8): a fresh private upload can be missing from a lagging uploads playlist, so a removed check
 * soon after it may mark it removed by mistake. While the mark stands, it frees the upload's plan slot for ANOTHER upload only once
 * the latest completed removed check (`channels.removed_check_at`) is at least this long after the upload. The queue gate only.
 */
export const REMOVED_MARK_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a standing removed mark frees the upload's slot for another upload (`uploadedAt`: `uploadTimeOf`, ms or null; `checkedAt`:
 * the channel's latest completed removed check). Unknown upload time -- not a fresh upload (a linked or Operator-written record,
 * no row) -- frees it; unknown check time holds it until the next completed check sets one.
 */
export function removedMarkFreesSlot(args: { uploadedAt: number | null; checkedAt: string | Date | null | undefined }): boolean {
  if (args.uploadedAt === null) return true;
  const checked = args.checkedAt ? new Date(args.checkedAt).getTime() : NaN;
  return Number.isFinite(checked) && checked - args.uploadedAt >= REMOVED_MARK_GRACE_MS;
}
