import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { ClipReviewClip, ClipReviewDecision, ClipReviewsSnapshot } from "@/lib/sync-gateway";

export { DomainError, isDomainError };
export type { ClipReviewClip, ClipReviewDecision };

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
};

/** This computer's copy of the clip: the submitted file, missing here, or a different file now. */
export type ClipFileState = "ok" | "missing" | "changed";

export type OwnerClipView = ClipReviewView & { file: ClipFileState };

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
};
