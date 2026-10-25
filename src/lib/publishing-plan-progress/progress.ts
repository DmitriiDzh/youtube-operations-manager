// BL-225 stage 2 (WEEKLY_PUBLISHING_PLAN.md, ADR 0051; AGENTS.md §M): what the release packages say of a weekly-plan slot -- the
// composition between `publishing` (the scan) and `publishing-plans` (the plan), so neither feature module imports the other. Pure:
// the scanned packages and the channel's AI-flag setting come in; the slot statuses go out.

import type { PlanSlotProgress } from "@/lib/publishing-plans";
import type { ScannedPackage } from "@/lib/publishing";

/** How far a status got, to pick one package when two name the same slot (the furthest one wins). */
const RANK: Record<PlanSlotProgress["status"], number> = { built: 1, packaged: 2, uploading: 3, failed: 3, scheduled: 4, published: 5 };

/**
 * One package naming a slot, as the slot's progress:
 * - not ready but its video file is there (no `video_missing`) -> `built`; not ready without the video -> nothing;
 * - ready -> `packaged`;
 * - uploaded (its `Vn_youtube.json`): `scheduled` / `published` by the channel's synced copy, otherwise still `packaged` with the
 *   video id (stage 3 adds `uploading` / `failed` from the upload rows).
 */
export function progressOfPackage(scanned: ScannedPackage, channelSyntheticMedia: boolean): PlanSlotProgress | null {
  const pkg = scanned.pkg;
  if (!pkg) return null;
  let status: PlanSlotProgress["status"] | null;
  switch (scanned.state) {
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
    code: null,
    videoId: scanned.youtube?.videoId ?? null,
    publishAt: scanned.youtube?.publishAt ?? null,
    package: {
      video: pkg.video,
      title: pkg.title,
      durationSeconds: pkg.durationSeconds,
      languages: Object.keys(pkg.localizations ?? {}).sort(),
      containsSyntheticMedia: pkg.containsSyntheticMedia ?? channelSyntheticMedia,
      thumbnailPath: scanned.thumbnailPath,
      testThumbnails: (pkg.thumbnails ?? []).filter((t) => t.role === "test").length,
      problems: scanned.problems.map((p) => p.code),
    },
  };
}

/** The progress of each asked slot from every package of the channel that names it (v2 `slotId`). */
export function progressOfSlots(packages: readonly ScannedPackage[], slotIds: readonly string[], channelSyntheticMedia: boolean): Map<string, PlanSlotProgress> {
  const wanted = new Set(slotIds);
  const result = new Map<string, PlanSlotProgress>();
  for (const scanned of packages) {
    const slotId = scanned.pkg?.slotId;
    if (!slotId || !wanted.has(slotId)) continue;
    const progress = progressOfPackage(scanned, channelSyntheticMedia);
    if (!progress) continue;
    const before = result.get(slotId);
    if (!before || RANK[progress.status] > RANK[before.status]) result.set(slotId, progress);
  }
  return result;
}

/** BL-225 stage 3: an upload row as the progress reads it (this computer's `publishing_uploads`). */
export type UploadRowForProgress = {
  slotId: string | null;
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
    : steps.planSync?.result === "refused" || steps.planSync?.result === "mismatch" ? `plan_${steps.planSync.action ?? "change"}_failed`
    : null;
  if (failedStep) return { status: "failed", code: failedStep, videoId: row.videoId };
  // The date counts only once it is on the video: written by the upload (or an old row's insert), or by the plan afterwards.
  const onVideo = steps.publishAt === "set" || steps.publishAt === "at_insert" || (steps.planSync?.result === "verified" && steps.planSync.action === "scheduled");
  if (row.publishAt === null || !onVideo) return { status: "packaged", code: null, videoId: row.videoId };
  return { status: Date.parse(row.publishAt) > nowMs ? "scheduled" : "published", code: null, videoId: row.videoId, publishAt: row.publishAt };
}

/** The packages' progress, with each slot's newest upload row on this computer taking precedence (it knows the upload's steps). */
export function progressWithUploads(fromPackages: Map<string, PlanSlotProgress>, rows: readonly UploadRowForProgress[], slotIds: readonly string[], nowMs: number): Map<string, PlanSlotProgress> {
  const result = new Map(fromPackages);
  const wanted = new Set(slotIds);
  const newest = new Map<string, UploadRowForProgress>();
  for (const row of rows) {
    if (!row.slotId || !wanted.has(row.slotId)) continue;
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
