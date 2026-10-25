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
