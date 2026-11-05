// BL-225 stage 2 (WEEKLY_PUBLISHING_PLAN.md, ADR 0051; AGENTS.md §M): what the release packages say of a weekly-plan slot -- the
// composition between `publishing` (the scan) and `publishing-plans` (the plan), so neither feature module imports the other. Pure:
// the scanned packages and the channel's AI-flag setting come in; the slot statuses go out.

import type { PlanSlotProgress } from "@/lib/publishing-plans";
import { VIDEO_DELETED_ON_YOUTUBE } from "@/lib/shared-video-presence";
import type { ScannedPackage } from "@/lib/publishing";

/** How far a status got, to pick one package when two name the same slot (the furthest one wins). */
const RANK: Record<PlanSlotProgress["status"], number> = { built: 1, packaged: 2, uploading: 3, failed: 3, scheduled: 4, published: 5 };

/**
 * One package naming a slot, as the slot's progress:
 * - not ready but its video file is there (no `video_missing`) -> `built`; not ready without the video -> nothing;
 * - ready -> `packaged`;
 * - uploaded (its `Vn_youtube.json`): `scheduled` / `published` by the channel's synced copy, otherwise still `packaged` with the
 *   video id (stage 3 adds `uploading` / `failed` from the upload rows);
 * - BL-243: its video deleted on YouTube (`deleted_on_youtube`) -> `failed` with `video_deleted_on_youtube`, the video id, no date.
 */
export function progressOfPackage(scanned: ScannedPackage, channelSyntheticMedia: boolean): PlanSlotProgress | null {
  const pkg = scanned.pkg;
  if (!pkg) return null;
  let status: PlanSlotProgress["status"] | null;
  let code: string | null = null;
  switch (scanned.state) {
    case "deleted_on_youtube":
      status = "failed";
      code = VIDEO_DELETED_ON_YOUTUBE;
      break;
    case "ready":
      status = "packaged";
      break;
    case "not_ready":
      status = scanned.problems.some((p) => p.code === "video_missing") ? null : "built";
      break;
    case "scheduled":
      status = "scheduled";
      break;
    case "published":
      status = "published";
      break;
    default:
      status = "packaged";
  }
  if (!status) return null;
  return {
    status,
    code,
    videoId: scanned.youtube?.videoId ?? null,
    publishAt: code === null ? (scanned.youtube?.publishAt ?? null) : null,
    package: {
      video: pkg.video,
      title: pkg.title,
      durationSeconds: pkg.durationSeconds,
      languages: Object.keys(pkg.localizations ?? {}).sort(),
      containsSyntheticMedia: pkg.containsSyntheticMedia ?? channelSyntheticMedia,
      thumbnailPath: scanned.thumbnailPath,
      testThumbnails: (pkg.thumbnails ?? []).filter((t) => t.role === "test").length,
      problems: scanned.problems.map((p) => p.code),
      // BL-242 (ADR 0062 §2): part of what the owner approves in the `packaged` stage.
      manifestSha256: scanned.manifestSha256,
    },
  };
}

/**
 * The progress of each asked slot from every package of the channel that names it (v2 `slotId`). BL-243: a package whose video
 * was deleted on YouTube speaks for its slot only when no other package names it (even one with no progress yet); of two such
 * packages the one uploaded last speaks -- by `uploadTimeOf` (its record's `uploadedAt`, else the one its upload row here
 * recorded; never a row's creation time); unknown for both: the first in the scan's order.
 */
export function progressOfSlots(
  packages: readonly ScannedPackage[],
  slotIds: readonly string[],
  channelSyntheticMedia: boolean,
  uploadRows: readonly UploadRowForProgress[] = []
): Map<string, PlanSlotProgress> {
  const wanted = new Set(slotIds);
  const result = new Map<string, PlanSlotProgress>();
  const named = new Set<string>();
  const deleted = new Map<string, { progress: PlanSlotProgress; at: number }>();
  const uploadedAtOf = (scanned: ScannedPackage): number => uploadTimeOf(scanned.youtube, rowOfVideo(uploadRows, scanned.youtube?.videoId)) ?? Number.NEGATIVE_INFINITY;
  for (const scanned of packages) {
    const slotId = scanned.pkg?.slotId;
    if (!slotId || !wanted.has(slotId)) continue;
    if (scanned.state === "deleted_on_youtube") {
      const progress = progressOfPackage(scanned, channelSyntheticMedia);
      const at = uploadedAtOf(scanned);
      const before = deleted.get(slotId);
      if (progress && (!before || at > before.at)) deleted.set(slotId, { progress, at });
      continue;
    }
    named.add(slotId);
    const progress = progressOfPackage(scanned, channelSyntheticMedia);
    if (!progress) continue;
    const before = result.get(slotId);
    if (!before || RANK[progress.status] > RANK[before.status]) result.set(slotId, progress);
  }
  for (const [slotId, { progress }] of deleted) if (!named.has(slotId)) result.set(slotId, progress);
  return result;
}

/** BL-243: a package the scan found deleted on YouTube, as the upload rows of its slot are judged against it. */
export type DeletedOnSlot = { video: string; uploadedAt: number | null };

/**
 * BL-243 (review round 4): THE upload time of a video -- the record's `uploadedAt`, else the `uploadedAt` its upload row recorded
 * (the runner writes the same moment into both); null when neither says. The one rule every comparison here uses.
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

/** The newest upload row of a video id, or null. */
function rowOfVideo(rows: readonly UploadRowForProgress[], videoId: string | undefined): UploadRowForProgress | null {
  if (!videoId) return null;
  let newest: UploadRowForProgress | null = null;
  for (const row of rows) if (row.videoId === videoId && (!newest || row.createdAt.getTime() > newest.createdAt.getTime())) newest = row;
  return newest;
}

/** BL-243: the packages the scan found deleted on YouTube, by the slot they name (with `uploadTimeOf` of each). */
export function deletedVideosBySlot(packages: readonly ScannedPackage[], uploadRows: readonly UploadRowForProgress[] = []): Map<string, DeletedOnSlot[]> {
  const out = new Map<string, DeletedOnSlot[]>();
  for (const p of packages) {
    const slotId = p.pkg?.slotId;
    if (p.state !== "deleted_on_youtube" || !slotId || !p.pkg) continue;
    const uploadedAt = uploadTimeOf(p.youtube, rowOfVideo(uploadRows, p.youtube?.videoId));
    out.set(slotId, [...(out.get(slotId) ?? []), { video: p.pkg.video, uploadedAt }]);
  }
  return out;
}

/** BL-243: what makes upload rows say nothing (from the scan the progress shows, so the two never disagree). */
export type UploadRowExclusions = {
  /** The video ids the scan read as removed on YouTube. */
  removedVideoIds?: ReadonlySet<string>;
  /** The deleted packages, by slot (`deletedVideosBySlot`). */
  deletedVideosBySlot?: ReadonlyMap<string, readonly DeletedOnSlot[]>;
};

/** BL-225 stage 3: an upload row as the progress reads it (this computer's `publishing_uploads`). */
export type UploadRowForProgress = {
  slotId: string | null;
  /** The video number the row uploaded (`V73`); BL-242 round 3: a row of another video than the slot's package says nothing of it. */
  video?: string;
  status: string;
  videoId: string | null;
  publishAt: string | null;
  errorCode: string | null;
  stepsJson: string;
  createdAt: Date;
};

type RowSteps = {
  localizations?: string;
  thumbnail?: string;
  playlist?: string;
  verify?: { result?: string };
  publishAt?: string;
  planSync?: { result?: string; action?: string };
};

const ACTIVE = new Set(["queued", "uploading", "processing", "finishing", "paused"]);

/**
 * One upload row's word on its slot (FO-REQ-0040 item 6 / acceptance 3): under way -> `uploading`; failed -> `failed` with its
 * code; done -> `failed` with the first step that kept the date off (`localizations_failed`, `thumbnail_failed`, ...), else
 * `scheduled` while its date is ahead and `published` once it passed; done without a date (uploaded before the slot was approved)
 * -> `packaged` with the video id. A cancelled row, or one released after an unknown outcome, says nothing.
 */
export function progressOfUploadRow(row: UploadRowForProgress, nowMs: number): Pick<PlanSlotProgress, "status" | "code" | "videoId" | "publishAt"> | null {
  if (row.status === "cancelled" || row.errorCode === "unknown_outcome_released") return null;
  if (ACTIVE.has(row.status)) return { status: "uploading", code: null, videoId: row.videoId };
  if (row.status === "failed") return { status: "failed", code: row.errorCode ?? "failed", videoId: row.videoId };
  let steps: RowSteps = {};
  try {
    steps = JSON.parse(row.stepsJson) as RowSteps;
  } catch {
    steps = {};
  }
  const failedStep =
    steps.localizations === "failed" ? "localizations_failed"
    : steps.localizations === "mismatch" ? "localizations_mismatch"
    : steps.thumbnail === "failed" ? "thumbnail_failed"
    : steps.playlist === "failed" ? "playlist_failed"
    : steps.verify?.result === "mismatch" ? "read_back_mismatch"
    : steps.publishAt === "failed" ? "publish_at_failed"
    : steps.publishAt === "skipped_too_soon" ? "publish_at_too_soon"
    // BL-243: `video_missing` on a row that counts (its video is not marked removed any more -- rows of removed videos never get
    // here) is a plain failed plan change, never healthy.
    : steps.planSync?.result === "refused" || steps.planSync?.result === "mismatch" || steps.planSync?.result === "video_missing" ? `plan_${steps.planSync.action ?? "change"}_failed`
    : null;
  if (failedStep) return { status: "failed", code: failedStep, videoId: row.videoId };
  // The date counts only once it is on the video: written by the upload (or an old row's insert), or by the plan afterwards.
  const onVideo = steps.publishAt === "set" || steps.publishAt === "at_insert" || (steps.planSync?.result === "verified" && steps.planSync.action === "scheduled");
  if (row.publishAt === null || !onVideo) return { status: "packaged", code: null, videoId: row.videoId };
  return { status: Date.parse(row.publishAt) > nowMs ? "scheduled" : "published", code: null, videoId: row.videoId, publishAt: row.publishAt };
}

/**
 * The packages' progress, with each slot's newest upload row on this computer taking precedence (it knows the upload's steps).
 * BL-243 (ADR 0063 §2, one rule): a row counts for its slot only when it was created after the newest deleted upload of that slot
 * and video number -- the removed video's own row here (its upload time, else its creation), else the deleted package's record
 * (`uploadedAt`); a deleted upload whose time is unknown blocks every row of that number. The removed video's own row never
 * counts. No deleted upload of that slot and number: the row counts. (The manifest is not part of the rule.)
 */
export function progressWithUploads(
  fromPackages: Map<string, PlanSlotProgress>,
  rows: readonly UploadRowForProgress[],
  slotIds: readonly string[],
  nowMs: number,
  exclude: UploadRowExclusions = {}
): Map<string, PlanSlotProgress> {
  const result = new Map(fromPackages);
  const wanted = new Set(slotIds);
  const removed = exclude.removedVideoIds ?? new Set<string>();
  // The newest deleted upload of each slot and number: the removed rows' times first, else the deleted packages' records.
  const deletedAt = new Map<string, number>();
  const key = (slotId: string, video: string) => `${slotId}|${video}`;
  for (const row of rows) {
    if (!row.slotId || row.video === undefined || row.videoId === null || !removed.has(row.videoId)) continue;
    const at = uploadTimeOf(null, row) ?? row.createdAt.getTime();
    deletedAt.set(key(row.slotId, row.video), Math.max(deletedAt.get(key(row.slotId, row.video)) ?? Number.NEGATIVE_INFINITY, at));
  }
  for (const [slotId, list] of exclude.deletedVideosBySlot ?? new Map<string, readonly DeletedOnSlot[]>()) {
    for (const d of list) if (!deletedAt.has(key(slotId, d.video))) deletedAt.set(key(slotId, d.video), d.uploadedAt ?? Number.POSITIVE_INFINITY);
  }
  const counts = (row: UploadRowForProgress & { slotId: string }): boolean => {
    if (row.videoId !== null && removed.has(row.videoId)) return false;
    if (row.video === undefined) return true;
    const cutoff = deletedAt.get(key(row.slotId, row.video));
    return cutoff === undefined || row.createdAt.getTime() > cutoff;
  };
  const newest = new Map<string, UploadRowForProgress>();
  for (const row of rows) {
    if (!row.slotId || !wanted.has(row.slotId) || !counts({ ...row, slotId: row.slotId })) continue;
    // BL-242 round 3 (b): a row of another video than the slot's current package (the old video moved to another slot) is not its
    // progress.
    const pkg = fromPackages.get(row.slotId)?.package;
    if (pkg && row.video !== undefined && row.video !== pkg.video) continue;
    const before = newest.get(row.slotId);
    if (!before || row.createdAt.getTime() > before.createdAt.getTime()) newest.set(row.slotId, row);
  }
  for (const [slotId, row] of newest) {
    const fromRow = progressOfUploadRow(row, nowMs);
    if (!fromRow) continue;
    const before = result.get(slotId);
    result.set(slotId, { ...fromRow, videoId: fromRow.videoId ?? before?.videoId ?? null, publishAt: fromRow.publishAt ?? before?.publishAt ?? null, package: before?.package ?? null });
  }
  return result;
}
