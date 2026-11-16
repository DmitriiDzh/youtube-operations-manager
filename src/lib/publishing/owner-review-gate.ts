import type { PackageProblem } from "./packages";

// BL-257 (ADR 0070), BL-265 (ADR 0072 §1): the owner-review gate's shape, shared by the package scan and the upload runner. Pure and
// import-free at run time on purpose: the upload runner is also pulled into client bundles for its pure helpers, so it must not reach
// the scan's filesystem imports.

/** BL-265: what identifies a package for the gate -- its manifest version and its media key (video code, the mp4's sha256 + size). */
export type OwnerReviewKey = {
  manifestSha256: string | null;
  video: string | null;
  videoSha256: string | null;
  videoSizeBytes: number | null;
};

/**
 * BL-257 (ADR 0070 §2), BL-265 (ADR 0072 §1): the owner's review of the channel's final packages, as the package-reviews module answers
 * it (the rule is that module's; the scan and the runner only apply it). `problemOf`: the problem to add (`owner_review_pending` /
 * `owner_review_returned`), or null when the package may be ready -- the owner approved its MEDIA (no thumbnail is part of it).
 */
export type OwnerReviewGate = {
  required: boolean;
  problemOf(key: OwnerReviewKey): PackageProblem | null;
};

/** A gate that could not be read: every package that would be ready waits for the owner (fail closed, AC-PR-07). */
export const CLOSED_OWNER_REVIEW_GATE: OwnerReviewGate = { required: true, problemOf: () => ({ code: "owner_review_pending" }) };

/**
 * BL-265 (ADR 0072 §6): what the automatic upload and the Producer's add may not take again -- manifest versions (rows made before
 * BL-265) and media keys (rows that froze the mp4's sha256). The rule that fills it is package-reviews' (`triedKeysOf`).
 */
export type TriedPackages = { manifests: Set<string>; media: Set<string> };

/** The one spelling of a media key in a `TriedPackages` set. */
export const mediaKeyOf = (video: string, videoSha256: string, sizeBytes: number) => `${video}\n${videoSha256.toLowerCase()}\n${sizeBytes}`;

/** Whether a package is tried: its manifest version, or its media (when the manifest states the mp4's sha256). */
export function isTriedPackage(tried: TriedPackages, p: { manifestSha256: string; video: string; videoSha256: string | null; sizeBytes: number }): boolean {
  return tried.manifests.has(p.manifestSha256) || (p.videoSha256 !== null && tried.media.has(mediaKeyOf(p.video, p.videoSha256, p.sizeBytes)));
}
