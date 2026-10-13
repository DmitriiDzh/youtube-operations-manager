import type { CredentialRef, ResolvedCredentials } from "@/lib/shared-domain";
import type { UploadProgress, VideoInsertResource, VideoUploadStateView } from "./types";

export type { CredentialRef, ResolvedCredentials, UploadProgress, VideoInsertResource, VideoUploadStateView };

/**
 * BL-182 stage 0 (ADR 0037 §7): the probe's upload, persisted so only that video can be deleted and an upload is never repeated.
 * `started` is saved before the first byte: until it becomes `uploaded`, the outcome is unknown and no new upload starts (review S1).
 */
export type G1ProbeRecord = {
  channelId: string;
  status: "started" | "uploaded";
  /** 1 for the first probe; 2 only for the one retry after YouTube rejected the first clip as a duplicate (plan §2 stage 0, 4a). */
  attempt: number;
  startedAt: string;
  videoId: string | null;
  uploadedAt: string | null;
  deletedAt: string | null;
  /** YouTube's `status.rejectionReason` from the read-back, e.g. `duplicate`. */
  rejectionReason: string | null;
};

export type G1UploadInput = {
  credentialRef: CredentialRef;
  channelId: string;
  /** The one retry after a duplicate rejection: only when the first probe's video was rejected as `duplicate` and deleted. */
  retryAfterDuplicate?: boolean;
  /** Relative to the channel workspace, `/` between folders. */
  relativePath: string;
  resource: VideoInsertResource;
};

export type G1UploadReport = {
  videoId: string;
  bytes: number;
  /** Polled until processing ended or the wait ran out; `null` when YouTube did not return the video. */
  state: VideoUploadStateView | null;
  waitedSeconds: number;
  /** A read-back that failed (the upload itself succeeded); the last state read is reported. */
  readError: string | null;
  /** What `snippet.defaultAudioLanguage` reads back as, against what was sent (`null` when nothing was sent). */
  defaultAudioLanguage: { sent: string | null; readBack: string | null };
};

export type G1DeleteReport = { videoId: string; goneOnYouTube: boolean; localRowRemoved: boolean };
