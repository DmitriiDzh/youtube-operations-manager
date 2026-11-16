// BL-225 stage 3 / BL-242 (ADR 0051 §7, ADR 0062 §3): a weekly-plan slot's decision as the uploads use it. Restated from the plan
// module (AGENTS.md §M: publishing never imports publishing-plans); the composition layer hands the plan's decisions over. Pure.

/** BL-242 (ADR 0062 §2): the package an approval names (the plan module's fingerprint, restated: §M). */
export type SlotPackageFingerprint = { video: string; manifestSha256: string; videoId: string | null };

/**
 * BL-225 stage 3: a plan slot's decision as the uploads use it (the plan module's `PlanSlotDecision`, restated: §M). BL-242: in
 * the `packaged` stage an approval (and a veto standing on one) names the package the owner approved.
 */
export type SlotDecision = { kind: "approved"; publishAt: string; package?: SlotPackageFingerprint; source?: SlotDatingSource; media?: SlotMediaKey } | { kind: "vetoed"; package?: SlotPackageFingerprint } | { kind: "pending" };

/** BL-267 (ADR 0073 §3): what dated the slot -- the owner's approved week template, or his explicit one-slot date. */
export type SlotDatingSource = "template" | "owner";

/**
 * BL-267 (ADR 0073 §3, plan §3.4): the media an approval stands on -- the package's video code, the mp4's SHA-256 and size -- so a
 * packaging-only re-package (BL-265: a new manifest hash) keeps the date. Absent on an older explicit approval: the manifest rule.
 */
export type SlotMediaKey = { video: string; videoSha256: string; sizeBytes: number };

/**
 * BL-242 (ADR 0062 §3): an approval dates an upload only of the package it names -- any package when it names none (the `slot`
 * stage), else the same manifest and, when it names a video id, that video (`videoId`: the upload's own, null before the insert).
 * BL-267 (ADR 0073 §3, AC-WT-17/42): an approval that names the media (video code, mp4 SHA-256, size) also dates an upload of the
 * same media under another manifest (a packaging-only re-package, BL-265); a different mp4 is not it.
 */
export function approvalNamesUpload(
  decision: Extract<SlotDecision, { kind: "approved" }>,
  upload: { manifestSha256: string; videoId: string | null; media?: { video: string; videoSha256: string | null; sizeBytes: number } | null }
): boolean {
  const named = decision.package;
  if (!named) return true;
  const videoOk = named.videoId === null || named.videoId === upload.videoId;
  if (named.manifestSha256 === upload.manifestSha256 && videoOk) return true;
  const media = decision.media;
  return Boolean(media && upload.media && upload.media.videoSha256 && media.video === upload.media.video && media.videoSha256 === upload.media.videoSha256.toLowerCase() && media.sizeBytes === upload.media.sizeBytes && videoOk);
}

/** BL-267: an upload row's media as `approvalNamesUpload` reads it (its frozen package JSON); null when it cannot be read. */
export function mediaOfPackageJson(packageJson: string): { video: string; videoSha256: string | null; sizeBytes: number } | null {
  try {
    const pkg = JSON.parse(packageJson) as { video?: unknown; videoSha256?: unknown; sizeBytes?: unknown };
    if (typeof pkg.video !== "string" || typeof pkg.sizeBytes !== "number") return null;
    return { video: pkg.video, videoSha256: typeof pkg.videoSha256 === "string" ? pkg.videoSha256 : null, sizeBytes: pkg.sizeBytes };
  } catch {
    return null;
  }
}
