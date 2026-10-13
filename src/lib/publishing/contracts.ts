import type { CredentialRef, ResolvedCredentials } from "@/lib/shared-domain";
import type { UploadProgress, VideoInsertResource, VideoUploadStateView } from "./types";

export type { CredentialRef, ResolvedCredentials, UploadProgress, VideoInsertResource, VideoUploadStateView };

/** BL-182 stage 0 (ADR 0037 §7): the one test upload, persisted so only that video can be deleted and the probe runs once. */
export type G1ProbeRecord = {
  channelId: string;
  videoId: string;
  uploadedAt: string;
  deletedAt: string | null;
};

export type G1UploadInput = {
  credentialRef: CredentialRef;
  channelId: string;
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
  /** What `snippet.defaultAudioLanguage` reads back as, against what was sent (`null` when nothing was sent). */
  defaultAudioLanguage: { sent: string | null; readBack: string | null };
};

export type G1DeleteReport = { videoId: string; goneOnYouTube: boolean; localRowRemoved: boolean };
