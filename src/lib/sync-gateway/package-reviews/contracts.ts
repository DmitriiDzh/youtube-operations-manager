import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-257 (ADR 0070, docs/roadmap/plans/PACKAGE_REVIEW_PLAN.md): the owner's review of a channel's final release packages, the same on
// every computer. One Automerge document per channel: the owner's switch (`required`, one register written whole) and his decisions
// (a flat map from the genesis, each under a fresh id and never edited), so two computers that each decide merge instead of one
// replacing the other. Which decision stands is the package-reviews module's rule; this family stores and carries.

/**
 * BL-265 (ADR 0072 §2): `packaging_comment` -- the owner's comment on a package's packaging (title, description, thumbnail, ...); it
 * never changes the gate. An older build drops the unknown kind (never an approval there).
 */
export type PackageReviewDecisionKind = "approved" | "returned" | "packaging_comment";

/** One owner decision on one manifest version (the manifest file's SHA-256); never edited. */
export type PackageReviewDecision = {
  id: string;
  manifestSha256: string;
  /** The package's video number (`V11`), for the reader. */
  video: string;
  /**
   * The default thumbnail file's SHA-256 when the owner decided. BL-257: an approval covered that thumbnail only; since BL-265 (ADR
   * 0072 §1) it is informational -- kept so an older build still reads a new approval (it ignores one with a null hash).
   */
  thumbnailSha256: string | null;
  /**
   * BL-265 (ADR 0072 §1): the media the decision is about -- the manifest's `sha256` (lower-case hex) and `sizeBytes` of the mp4. With
   * both set, an approval / return stands for that mp4 under this video code (or its BL-263 recode alias), whatever its manifest says
   * about packaging. Absent on a decision written before BL-265 (it stands for its `manifestSha256` only).
   */
  videoSha256?: string;
  videoSizeBytes?: number;
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
  /**
   * Owner TG 4584 (BL-263 fix): set only on a copy that a local recode (`factory_release_recode`, V -> S: files renamed, the
   * manifest's `video` and file fields rewritten, the mp4 and thumbnail bytes unchanged) made of the owner's latest decision on the
   * earlier manifest version -- that earlier manifest's SHA-256. `kind`, `comment`, `thumbnailSha256`, `device` and `at` are the
   * original's. Absent on the owner's own decisions; an older build ignores it.
   */
  carriedFrom?: string;
  /**
   * Owner TG 4817 (PACKAGE_REVIEW_PLAN.md AC-TC-05): the owner's comments bound to moments of the video, sent with this approval or
   * return as one batch -- seconds (one decimal) and text, sorted by time. Absent when there are none; an older build ignores it.
   */
  timedComments?: Array<{ atSeconds: number; text: string }>;
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
