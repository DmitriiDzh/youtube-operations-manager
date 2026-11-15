import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-257 (ADR 0070, docs/roadmap/plans/PACKAGE_REVIEW_PLAN.md): the owner's review of a channel's final release packages, the same on
// every computer. One Automerge document per channel: the owner's switch (`required`, one register written whole) and his decisions
// (a flat map from the genesis, each under a fresh id and never edited), so two computers that each decide merge instead of one
// replacing the other. Which decision stands is the package-reviews module's rule; this family stores and carries.

export type PackageReviewDecisionKind = "approved" | "returned";

/** One owner decision on one manifest version (the manifest file's SHA-256); never edited. */
export type PackageReviewDecision = {
  id: string;
  manifestSha256: string;
  /** The package's video number (`V11`), for the reader. */
  video: string;
  /** The default thumbnail file's SHA-256 when the owner decided: an approval covers that thumbnail only. */
  thumbnailSha256: string | null;
  kind: PackageReviewDecisionKind;
  /** A return always has one; an approval may. */
  comment: string | null;
  by: "owner";
  /** The computer it was made on (host name), or null. */
  device: string | null;
  at: string;
  /**
   * Review L1: the document's own order -- one more than the highest `seq` this computer's copy held when it wrote the decision, so a
   * decision made after seeing another one orders after it whatever the two computers' clocks say. Set by the store; two decisions
   * made offline at once may share one (then `at`, then `id`). Absent on a decision written without it.
   */
  seq?: number;
};

/** The owner's switch: review the channel's final packages before they count as ready. Assigned whole. */
export type PackageReviewRequired = { value: boolean; updatedAt: string; by: "owner"; device: string | null };

export type PackageReviewsDocument = {
  format: "ytm-package-reviews";
  version: 1;
  channelId: string;
  /** Absent until the owner first switches it. */
  required?: PackageReviewRequired;
  /** By decision id. */
  decisions: Record<string, PackageReviewDecision>;
};

/**
 * The document as plain data. `exists` false: this computer has no document for the channel (never switched here or synced) -- the
 * gate is off. A document that exists but cannot be loaded makes `read` throw (the module reads that as "required, nothing approved").
 */
export type PackageReviewsSnapshot = { exists: boolean; required: PackageReviewRequired | null; decisions: Record<string, PackageReviewDecision> };

export type MergeResult = { newConflicts: [] };
