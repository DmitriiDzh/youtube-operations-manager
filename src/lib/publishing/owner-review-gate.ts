import type { PackageProblem } from "./packages";

// BL-257 (ADR 0070): the owner-review gate's shape, shared by the package scan and the upload runner. Pure and import-free at run
// time on purpose: the upload runner is also pulled into client bundles for its pure helpers, so it must not reach the scan's
// filesystem imports.

/**
 * BL-257 (ADR 0070 §2): the owner's review of the channel's final packages, as the package-reviews module answers it (the rule is
 * that module's; the scan only applies it). `needsThumbnailHash`: an approval stands for this manifest, so the thumbnail file's hash
 * decides; `problemOf`: the problem to add (`owner_review_pending` / `owner_review_returned`), or null when the package may be ready.
 */
export type OwnerReviewGate = {
  required: boolean;
  needsThumbnailHash(manifestSha256: string): boolean;
  problemOf(manifestSha256: string | null, thumbnailSha256: string | null): PackageProblem | null;
};

/** A gate that could not be read: every package that would be ready waits for the owner (fail closed, AC-PR-07). */
export const CLOSED_OWNER_REVIEW_GATE: OwnerReviewGate = { required: true, needsThumbnailHash: () => false, problemOf: () => ({ code: "owner_review_pending" }) };

