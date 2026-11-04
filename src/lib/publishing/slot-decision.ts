// BL-225 stage 3 / BL-242 (ADR 0051 §7, ADR 0062 §3): a weekly-plan slot's decision as the uploads use it. Restated from the plan
// module (AGENTS.md §M: publishing never imports publishing-plans); the composition layer hands the plan's decisions over. Pure.

/** BL-242 (ADR 0062 §2): the package an approval names (the plan module's fingerprint, restated: §M). */
export type SlotPackageFingerprint = { video: string; manifestSha256: string; videoId: string | null };

/**
 * BL-225 stage 3: a plan slot's decision as the uploads use it (the plan module's `PlanSlotDecision`, restated: §M). BL-242: in
 * the `packaged` stage an approval (and a veto standing on one) names the package the owner approved.
 */
export type SlotDecision = { kind: "approved"; publishAt: string; package?: SlotPackageFingerprint } | { kind: "vetoed"; package?: SlotPackageFingerprint } | { kind: "pending" };

/**
 * BL-242 (ADR 0062 §3): an approval dates an upload only of the package it names -- any package when it names none (the `slot`
 * stage), else the same manifest and, when it names a video id, that video (`videoId`: the upload's own, null before the insert).
 */
export function approvalNamesUpload(decision: Extract<SlotDecision, { kind: "approved" }>, upload: { manifestSha256: string; videoId: string | null }): boolean {
  const named = decision.package;
  if (!named) return true;
  return named.manifestSha256 === upload.manifestSha256 && (named.videoId === null || named.videoId === upload.videoId);
}
