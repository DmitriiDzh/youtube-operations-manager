import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { PackageReviewDecision, PackageReviewDecisionKind, PackageReviewRequired, PackageReviewsSnapshot } from "@/lib/sync-gateway";
import type { DraftTimedComment, TimedComment } from "./timed-comments";

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
 * What the gate needs to know of a channel (ADR 0070 §1, ADR 0072 §1): whether it is on, the owner's well-formed approvals and returns
 * (oldest first, packaging comments left out) and the BL-263 recode aliases (V -> S) known here. Which decision stands is
 * `model.standingDecision`'s rule.
 */
export type OwnerReviewState = {
  required: boolean;
  decisions: PackageReviewDecision[];
  aliases: ReadonlyMap<string, string>;
};

/**
 * BL-265 (ADR 0072 §1): what identifies a package for the gate -- its manifest version (a BL-257 decision stands for it alone) and its
 * media key (channel implied, video code, the manifest's mp4 `sha256` + `sizeBytes`). Null where unknown.
 */
export type ReviewKey = {
  manifestSha256: string | null;
  video: string | null;
  videoSha256: string | null;
  videoSizeBytes: number | null;
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
  /** The owner's decision that stands for this package's media (ADR 0072 §1), or null. */
  decision: "approved" | "returned" | null;
  /** That decision's comment (a return always has one), else null. */
  comment: string | null;
  /** Owner TG 4817 (AC-TC-09): that decision's timed comments, sorted by time ([] when none). */
  timedComments: TimedComment[];
  decidedAt: string | null;
  decidedOn: string | null;
  /** The manifest states the video's `sha256` (without it the package cannot be approved, AC-PR-05). */
  hasVideoSha256: boolean;
  /** The package's other problems (codes): the factory still has to fix them before it can be ready. */
  otherProblems: string[];
  /** BL-265 (ADR 0072 §2): the owner's packaging comments on this package's video (newest first), never part of the gate. */
  packagingComments: Array<{ id: string; comment: string; at: string; device: string | null }>;
  /** BL-265: the YouTube video id once uploaded (the review screen links the uploaded package's own row), else null. */
  videoId: string | null;
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
  /** BL-265: the manifest's `sizeBytes` of the video (the media key's size). */
  videoSizeBytes: number;
  uploaded: boolean;
  /** BL-265: the YouTube video id from the upload record, else null. */
  videoId?: string | null;
  /** Problem codes of the scan other than this module's own. */
  otherProblems: string[];
};

export type ReviewPackagesResult = { status: "ok"; packages: ReviewPackage[] } | { status: "no_workspace" | "workspace_unavailable" };

/**
 * Owner TG 4817 (AC-TC-03): the owner's draft of timed comments for one package on this computer -- device-local, never synced,
 * cleared once a decision carrying them is stored. `updatedAt` null: no draft.
 */
export type PackageReviewDraft = { manifestSha256: string; comments: DraftTimedComment[]; updatedAt: string | null };

/** A local file the media routes stream (absolute path, size, browser type). */
export type PackageMediaFile = { path: string; bytes: number; type: string };
