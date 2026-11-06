import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { ClipReviewAttachment, ClipReviewClip, ClipReviewDecision, ClipReviewsSnapshot } from "@/lib/sync-gateway";

export { DomainError, isDomainError };
export type { ClipReviewAttachment, ClipReviewClip, ClipReviewDecision };

// BL-241 (ADR 0061, docs/roadmap/plans/CLIP_REVIEWS_PLAN.md): clips for review. The Producer submits a short scene-loop clip that is
// already in the channel's folder; only the owner approves or returns it, in the Web UI. A feature module of its own (AGENTS.md §M):
// no other feature module, no Google client, no network -- the files, the channel check and the store are ports.

export const CLIP_REVIEW_LIMITS = Object.freeze({
  sceneId: 80,
  note: 2000,
  comment: 2000,
  clipPath: 500,
  /** Pending clips per channel at most. */
  pending: 50,
  // Owner/Producer 2026-11-03: loop previews are 15-20 s, renders up to 2 min; the range is wide on purpose.
  minSeconds: 5,
  maxSeconds: 300,
  /** A rendered "30 s" preview may measure 29.97 s. */
  toleranceSeconds: 0.5,
  listDefault: 50,
  listMax: 200,
});

/** The video kinds a clip may be, by extension, with the type the browser is told. */
export const CLIP_VIDEO_TYPES: Readonly<Record<string, string>> = Object.freeze({ ".mp4": "video/mp4", ".webm": "video/webm" });

export type ClipReviewStatus = "pending" | "approved" | "returned" | "withdrawn";

/** A clip as the Producer reads it (and the owner, with `file`). Never an absolute path. */
export type ClipReviewView = {
  clipId: string;
  channelId: string;
  sceneId: string;
  clipPath: string;
  note: string;
  startSec: number | null;
  endSec: number | null;
  durationSeconds: number;
  sizeBytes: number;
  sha256: string;
  submittedAt: string;
  /** The computer it was submitted on. */
  device: string | null;
  status: ClipReviewStatus;
  /** The owner's comment (a return always has one), null otherwise. */
  comment: string | null;
  decidedAt: string | null;
  /** The computer the deciding record was made on. */
  decidedOn: string | null;
  /** BL-246 (ADR 0065): the files the owner attached to the deciding decision; [] otherwise (and for every older decision). */
  attachments: ClipReviewAttachment[];
};

/** This computer's copy of the clip: the submitted file, missing here, or a different file now. */
export type ClipFileState = "ok" | "missing" | "changed";

/** BL-246: one attachment as the owner's screen reads it: its place in the decision (the serving route's index) and this computer's copy (by size). */
export type OwnerAttachmentView = ClipReviewAttachment & { index: number; file: ClipFileState };

export type OwnerClipView = Omit<ClipReviewView, "attachments"> & {
  file: ClipFileState;
  /** The deciding record's id (the attachments' folder), null while pending. */
  decisionId: string | null;
  attachments: OwnerAttachmentView[];
};

/** BL-246: the workspace folder the owner's attachments go into, below the workspace root (`/` between folders). */
export const CLIP_ATTACHMENTS_FOLDER = "99 Data Exchange/From YTM/clip-reviews";

/** BL-246: an upload staged on this computer (app data) for the owner's next decision on one clip. */
export type StagedAttachment = {
  uploadId: string;
  channelId: string;
  clipId: string;
  /** The name as the browser gave it (sanitized when the decision is made, by its place). */
  rawName: string;
  /** The type the browser declared ("" when none). */
  declaredType: string;
  size: number;
  /** The browser's SHA-256 of the whole file (hex), checked when the last piece arrives and again at the decision. */
  sha256: string;
  createdAt: string;
};

/** BL-246: a file to copy into the decision folder. */
export type AttachmentToWrite = { sourcePath: string; name: string; size: number; sha256: string };

/** A file the ports resolved inside the channel workspace (absolute: never sent to the browser or an agent). */
export type ResolvedClipFile = { path: string; bytes: number };

export type ClipReviewsPorts = {
  store: {
    read(channelId: string): Promise<ClipReviewsSnapshot>;
    addClip(channelId: string, clip: ClipReviewClip): Promise<void>;
    addDecision(channelId: string, decision: ClipReviewDecision): Promise<void>;
  };
  /** Whether the channel is connected on this computer (Settings → Channels). */
  isChannelConnected(channelId: string): Promise<boolean>;
  /** This computer's workspace folder of the channel, or null when none is set. */
  workspace(channelId: string): Promise<string | null>;
  /**
   * The shared workspace rule: `relativePath` relative to the workspace, no `..` or absolute path, its real path strictly inside the
   * workspace's real path, a regular file. `{ ok: false, reason }` otherwise (the file missing included).
   */
  resolveFile(workspace: string, relativePath: string): Promise<({ ok: true } & ResolvedClipFile) | { ok: false; reason: string }>;
  /** The video's duration in seconds by ffprobe; null when ffprobe is not here or cannot read it. */
  probeDurationSeconds(absolutePath: string): Promise<number | null>;
  /** The file's SHA-256 (hex). */
  hashFile(absolutePath: string): Promise<string>;
  /** Throws while the app is paused for a device handoff or recovery (the device mutation gate). */
  assertDeviceAvailable(): Promise<void>;
  deviceLabel(): Promise<string | null>;
  now(): Date;
  randomId(): string;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** An owner decision, recorded on the computer it was made on. */
  audit(entry: { channelId: string; clipId: string; detail: Record<string, unknown> }): Promise<void>;
  /** BL-246: uploads staged in this computer's app data (never the channel folder) until a decision uses them. */
  staging: {
    create(upload: StagedAttachment): Promise<void>;
    /** The upload, how many bytes arrived, and its file; null when unknown. */
    get(uploadId: string): Promise<{ upload: StagedAttachment; received: number; path: string } | null>;
    /** Appends bytes at the end (the service has checked the offset); answers the new length. */
    append(uploadId: string, bytes: Uint8Array): Promise<number>;
    /** The first `count` bytes. */
    head(uploadId: string, count: number): Promise<Uint8Array>;
    /** All bytes (a text attachment, at most 50 MiB). */
    readAll(uploadId: string): Promise<Uint8Array>;
    hash(uploadId: string): Promise<string>;
    remove(uploadId: string): Promise<void>;
    /** Removes uploads staged before `cutoff`. */
    removeOlderThan(cutoff: Date): Promise<void>;
  };
  /** BL-246: the decision's folder `<workspace>/99 Data Exchange/From YTM/clip-reviews/<clipId>/<decisionId>/` (the shared rule). */
  attachmentFiles: {
    /**
     * Makes the decision folder (refused when it already exists), copies each file under a temporary name, checks its size and
     * SHA-256 and renames it. On any failure removes the folder it made, then throws.
     */
    write(workspace: string, clipId: string, decisionId: string, files: readonly AttachmentToWrite[]): Promise<void>;
    /** Removes the decision folder (a decision that could not be recorded). */
    remove(workspace: string, clipId: string, decisionId: string): Promise<void>;
    /** One file of the decision folder: null when it (or its folder) is not here; throws when it is there but may not be used. */
    resolve(workspace: string, clipId: string, decisionId: string, name: string): Promise<ResolvedClipFile | null>;
  };
};
