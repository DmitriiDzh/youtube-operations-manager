/**
 * BL-238 (FO-REQ-0051, ADR 0058): local video cleanup -- once YouTube holds an upload, the release's own `V<n> <channel>.mp4` is
 * deleted from the channel folder (permanently), a tombstone `….mp4.deleted.json` is left in its place, and every delete or
 * refusal is logged. Its own feature module (AGENTS.md §M): nothing else imports it; it reads other modules' rows through db.ts.
 */

/** How often the sweep runs, and the first run after the start. */
export const CLEANUP_SWEEP_INTERVAL_MS = 30 * 60_000;
export const CLEANUP_FIRST_SWEEP_DELAY_MS = 3 * 60_000;
/** YouTube's `videos.list` takes up to 50 ids per call (1 unit). */
export const CLEANUP_READ_BATCH = 50;
/** Without YouTube's file size: the local duration must be this close to YouTube's. */
export const CLEANUP_DURATION_TOLERANCE_SECONDS = 2;

export const TOMBSTONE_SCHEMA = "deleted-video/1";
export const TOMBSTONE_SUFFIX = ".deleted.json";
export const CLEANUP_DELETED_BY = "ytm-cleanup";

/** The Operator's contract (FO-REQ-0051): written next to the deleted mp4, read by the workflow bundle. */
export type VideoTombstone = {
  schema: typeof TOMBSTONE_SCHEMA;
  file: string;
  bytes: number;
  sha256: string | null;
  durationSec: number | null;
  youtubeVideoId: string;
  privacyStatus: string;
  publishAt: string | null;
  deletedAt: string;
  deletedBy: string;
  /** Always empty: job folders are the bundle's own cleanup (ADR 0058 §2). */
  tempDeleted: string[];
};

/** Not now -- checked again at the next sweep. */
export type CleanupWaitReason =
  | "processing"
  | "not_public_or_scheduled"
  | "youtube_unavailable"
  | "workspace_unavailable"
  | "in_live_rotation"
  | "upload_active"
  | "cannot_verify"
  /** The publishing runner finished the upload with a problem (read-back mismatch, a failed step): the owner may still redo it. */
  | "upload_problem"
  /** YouTube does not return the video (deleted, or not visible to the approver's account now): the file is kept. */
  | "video_not_on_youtube"
  /** The tombstone could not be written or read back, or the unlink failed: nothing was deleted (or only the tombstone is there). */
  | "delete_failed";

/** Never -- the file is not proven to be the uploaded one, or the path is not one we may touch. Logged once, never tried again. */
export type CleanupRefuseReason =
  | "path_not_allowed"
  | "symlink"
  | "not_a_file"
  | "upload_incomplete"
  | "size_mismatch_upload"
  | "size_mismatch_youtube"
  | "sha256_mismatch"
  | "duration_mismatch"
  | "youtube_rejected"
  | "tombstone_mismatch"
  /** The mp4 is already gone without this cleanup's tombstone (deleted by hand): nothing to do, logged once. */
  | "file_missing";

export type CleanupDecision =
  | { action: "delete" }
  | { action: "wait"; reason: CleanupWaitReason }
  | { action: "refuse"; reason: CleanupRefuseReason }
  /** The mp4 is gone and this cleanup's own tombstone for this video is there: a delete whose log entry was cut by a crash. */
  | { action: "recovered"; bytes: number };

export type CleanupChannelSetting = { enabled: boolean; enabledAt: number | null };
export type CleanupSettings = { channels: Record<string, CleanupChannelSetting> };

export type CleanupLogAction = "deleted" | "refused";

/** One row of `local_video_cleanup_log`. */
export type CleanupLogEntry = {
  id: string;
  channelId: string;
  uploadId: string;
  video: string;
  path: string;
  bytes: number | null;
  videoId: string | null;
  action: CleanupLogAction;
  reason: string | null;
  at: number;
};

/** The card's view of a channel on this computer. */
export type CleanupChannelView = {
  channelId: string;
  enabled: boolean;
  enabledAt: string | null;
  freedBytes: number;
  deletedCount: number;
  /** Uploads waiting (the reason of the last sweep), newest first. */
  waiting: Array<{ video: string; reason: CleanupWaitReason; checkedAt: string }>;
  recent: Array<{ video: string; action: CleanupLogAction; reason: string | null; bytes: number | null; at: string; path: string }>;
};
