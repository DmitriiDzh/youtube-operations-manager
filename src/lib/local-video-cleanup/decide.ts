// BL-238 (ADR 0058 §3): the decision for one upload, from facts gathered fresh. Pure. Local facts come first, so a file that
// cannot be deleted anyway costs no YouTube read; the hash and the duration (slow) are checked last, only for a file about to go.

import { isAllowedReleaseVideo } from "./allowlist";
import type { CleanupDecision, CleanupRefuseReason, CleanupWaitReason, VideoTombstone } from "./contracts";
import { CLEANUP_DELETED_BY, CLEANUP_DURATION_TOLERANCE_SECONDS } from "./contracts";

export type CleanupUploadFacts = {
  video: string;
  videoFile: string;
  videoId: string | null;
  storedBytes: number | null;
  totalBytes: number | null;
  /** The publishing runner's problem code on a finished upload (null = finished cleanly). */
  errorCode?: string | null;
};

export type LocalFileFacts =
  | { kind: "unavailable" }
  | { kind: "missing"; tombstone: VideoTombstone | null }
  | { kind: "symlink" }
  | { kind: "not_a_file" }
  | { kind: "file"; bytes: number; tombstone: VideoTombstone | null };

export type YoutubeVideoFacts =
  | { kind: "unavailable" }
  | { kind: "missing" }
  | {
      kind: "ok";
      uploadStatus: string | null;
      processingStatus: string | null;
      privacyStatus: string | null;
      publishAt: string | null;
      fileSize: number | null;
      durationSeconds: number | null;
    };

const wait = (reason: CleanupWaitReason): CleanupDecision => ({ action: "wait", reason });
const refuse = (reason: CleanupRefuseReason): CleanupDecision => ({ action: "refuse", reason });

/** Before any YouTube read: the upload row, the path and the file on this computer. `null` = go on to the YouTube checks. */
export function decideLocally(args: { upload: CleanupUploadFacts; channelName: string; local: LocalFileFacts; inLiveRotation: boolean; uploadActive: boolean }): CleanupDecision | null {
  const { upload, local } = args;
  if (!upload.videoId || upload.totalBytes === null || upload.storedBytes !== upload.totalBytes) return refuse("upload_incomplete");
  // Review #1: an unreachable workspace (no channel name either) waits -- never a refusal that would stick after the disk is back.
  if (local.kind === "unavailable") return wait("workspace_unavailable");
  if (!isAllowedReleaseVideo(upload.videoFile, upload.video, args.channelName)) return refuse("path_not_allowed");
  if (local.kind === "symlink") return refuse("symlink");
  if (local.kind === "not_a_file") return refuse("not_a_file");
  if (local.kind === "missing") {
    const own = local.tombstone && local.tombstone.deletedBy === CLEANUP_DELETED_BY && local.tombstone.youtubeVideoId === upload.videoId;
    return own && local.tombstone ? { action: "recovered", bytes: local.tombstone.bytes } : refuse("file_missing");
  }
  if (local.tombstone && (local.tombstone.youtubeVideoId !== upload.videoId || local.tombstone.bytes !== local.bytes)) return refuse("tombstone_mismatch");
  if (local.bytes !== upload.totalBytes) return refuse("size_mismatch_upload");
  if (args.inLiveRotation) return wait("in_live_rotation");
  if (args.uploadActive) return wait("upload_active");
  if (upload.errorCode) return wait("upload_problem");
  return null;
}

const REJECTED_UPLOAD = new Set(["rejected", "failed", "deleted"]);

/** YouTube's side. `delete` carries what is still to verify on the file: its sha256 (when known) and, without a size, its duration. */
export function decideOnYoutube(args: { localBytes: number; youtube: YoutubeVideoFacts }): CleanupDecision {
  const yt = args.youtube;
  if (yt.kind === "unavailable") return wait("youtube_unavailable");
  if (yt.kind === "missing") return wait("video_not_on_youtube");
  if (yt.uploadStatus && REJECTED_UPLOAD.has(yt.uploadStatus)) return refuse("youtube_rejected");
  if (yt.processingStatus === "failed" || yt.processingStatus === "terminated") return refuse("youtube_rejected");
  if (yt.processingStatus !== "succeeded" && yt.uploadStatus !== "processed") return wait("processing");
  const scheduled = yt.privacyStatus === "private" && !!yt.publishAt;
  if (yt.privacyStatus !== "public" && !scheduled) return wait("not_public_or_scheduled");
  if (yt.fileSize !== null && yt.fileSize !== args.localBytes) return refuse("size_mismatch_youtube");
  return { action: "delete" };
}

/** The slow checks, run only for a file about to be deleted. */
export function decideOnContent(args: {
  expectedSha256: string | null;
  actualSha256: string | null;
  youtubeFileSize: number | null;
  youtubeDurationSeconds: number | null;
  localDurationSeconds: number | null | "no_ffprobe";
}): CleanupDecision {
  if (args.expectedSha256 !== null && args.actualSha256 !== null && args.expectedSha256.toLowerCase() !== args.actualSha256.toLowerCase()) return refuse("sha256_mismatch");
  if (args.expectedSha256 !== null && args.actualSha256 === null) return wait("cannot_verify");
  if (args.youtubeFileSize === null) {
    const local = args.localDurationSeconds;
    if (local === null || local === "no_ffprobe" || args.youtubeDurationSeconds === null) return wait("cannot_verify");
    if (Math.abs(local - args.youtubeDurationSeconds) > CLEANUP_DURATION_TOLERANCE_SECONDS) return refuse("duration_mismatch");
  }
  return { action: "delete" };
}

/** ISO 8601 duration as YouTube gives it (`PT3H0M12S`, `P1DT2H`) in seconds; null when it is not one. */
export function isoDurationSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!m || value === "P" || value === "PT") return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}
