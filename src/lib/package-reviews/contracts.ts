import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { PackageReviewDecision, PackageReviewDecisionKind, PackageReviewRequired, PackageReviewsSnapshot } from "@/lib/sync-gateway";

export { DomainError, isDomainError };
export type { PackageReviewDecision, PackageReviewDecisionKind, PackageReviewRequired, PackageReviewsSnapshot };

// BL-257 (ADR 0070, docs/roadmap/plans/PACKAGE_REVIEW_PLAN.md): the owner reviews a channel's final release package before it counts
// as ready. A feature module of its own (AGENTS.md §M): it imports no other feature module, no Google client and no network -- the
// channel's packages, their files and the store are ports (the composition layer wires the publishing scan in). Only the owner's
// Web UI decides or switches (AC-PR-08); agents read the result as the package scan's problem codes.

/** The package scan's problem codes this module adds (`publishingPackages.problem.<code>` in the interface). */
export const OWNER_REVIEW_PENDING = "owner_review_pending";
export const OWNER_REVIEW_RETURNED = "owner_review_returned";
export const OWNER_REVIEW_PROBLEM_CODES: readonly string[] = [OWNER_REVIEW_PENDING, OWNER_REVIEW_RETURNED];

export const PACKAGE_REVIEW_LIMITS = Object.freeze({
  comment: 2000,
  /** Uploaded packages the owner decided on, kept in the list (newest first) for reference. */
  uploadedShown: 10,
});

/**
 * What the package scan needs to know of a channel (ADR 0070 §2-§3): whether the gate is on, and for each manifest version whose
 * LATEST owner decision is an approval the thumbnail hash it covers (and when), or whose latest is a return the comment.
 */
export type OwnerReviewState = {
  required: boolean;
  approved: Map<string, { thumbnailSha256: string | null; at: string }>;
  returned: Map<string, string>;
};

export type PackageReviewItemState = "pending" | "approved" | "returned" | "uploaded";

/** One package of the channel as the review screen shows it. Never an absolute path. */
export type PackageReviewItem = {
  manifestSha256: string;
  manifestPath: string;
  video: string;
  title: string;
  description: string;
  /** The translation languages the package carries. */
  languages: string[];
  slotId: string | null;
  plannedPublishDate: string | null;
  durationSeconds: number;
  /** Relative to the workspace (the package's default thumbnail), or null when the file is missing. */
  thumbnailPath: string | null;
  state: PackageReviewItemState;
  /** The latest owner decision for this manifest, or null. */
  decision: "approved" | "returned" | null;
  /** The latest owner decision's comment for this manifest (a return always has one), else null. */
  comment: string | null;
  decidedAt: string | null;
  decidedOn: string | null;
  /** The manifest states the video's `sha256` (without it the package cannot be approved, AC-PR-05). */
  hasVideoSha256: boolean;
  /** The package's other problems (codes): the factory still has to fix them before it can be ready. */
  otherProblems: string[];
};

export type PackageReviewsView = {
  channelId: string;
  required: boolean;
  requiredUpdatedAt: string | null;
  /** False when the review document exists but cannot be read here (the gate then holds every package). */
  readable: boolean;
  /** "ok", or why the channel's packages cannot be listed on this computer. */
  packages: "ok" | "no_workspace" | "workspace_unavailable";
  items: PackageReviewItem[];
  /** Packages waiting for the owner (pending); always 0 while the gate is off (review M2). */
  waiting: number;
};

/** A package of the channel as the composition layer hands it over (from the publishing scan). Paths are relative to the workspace. */
export type ReviewPackage = {
  manifestSha256: string;
  manifestPath: string;
  video: string;
  title: string;
  description: string;
  languages: string[];
  slotId: string | null;
  plannedPublishDate: string | null;
  durationSeconds: number;
  videoPath: string;
  /** The default thumbnail's path when its file exists, else null. */
  thumbnailPath: string | null;
  /** The manifest's `sha256` of the video (lower-case hex), or null. */
  videoSha256: string | null;
  uploaded: boolean;
  /** Problem codes of the scan other than this module's own. */
  otherProblems: string[];
};

export type ReviewPackagesResult = { status: "ok"; packages: ReviewPackage[] } | { status: "no_workspace" | "workspace_unavailable" };

/** A local file the media routes stream (absolute path, size, browser type). */
export type PackageMediaFile = { path: string; bytes: number; type: string };
