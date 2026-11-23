import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { ImageReviewDecision, ImageReviewImage, ImageReviewsSnapshot } from "@/lib/sync-gateway";

export { DomainError, isDomainError };
export type { ImageReviewDecision, ImageReviewImage };

// BL-272 (ADR 0076, owner TG 2547 via the Producer): master still images for review. The Producer submits a scene's 1920×1080 master
// still that is already in the channel's folder; only the owner approves it, approves it with a note, or returns it, in the Web UI
// (Медиа → «Кадры»). A feature module of its own (AGENTS.md §M): no other feature module, no Google client, no network -- the files,
// the channel check and the store are ports. The clip-reviews pattern (ADR 0061); the deciding rule and the file adapter are shared
// with it through `src/lib/review-items/`.

export const IMAGE_REVIEW_LIMITS = Object.freeze({
  sceneId: 80,
  note: 2000,
  comment: 2000,
  imagePath: 500,
  /** The Producer's ids (batch, request). */
  key: 80,
  /** Pending images per channel at most. */
  pending: 200,
  /** Images per batch at most (the Producer sends ~20; the grid stays usable). */
  batch: 40,
  /** A master still is a few MB; anything this large is not one. */
  maxBytes: 50 * 1024 * 1024,
  minSide: 16,
  maxSide: 16384,
  listDefault: 50,
  listMax: 200,
});

/** The image kinds a still may be, by extension, with the format its header must have and the type the browser is told. */
export const IMAGE_FILE_TYPES: Readonly<Record<string, { format: "png" | "jpeg"; type: string }>> = Object.freeze({
  ".png": { format: "png", type: "image/png" },
  ".jpg": { format: "jpeg", type: "image/jpeg" },
  ".jpeg": { format: "jpeg", type: "image/jpeg" },
});

export type ImageReviewStatus = "pending" | "approved" | "approved_with_note" | "returned" | "withdrawn";

/** An image as the Producer reads it (and the owner, with `file`). Never an absolute path. */
export type ImageReviewView = {
  imageId: string;
  channelId: string;
  sceneId: string;
  imagePath: string;
  note: string;
  batchId: string | null;
  requestId: string | null;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  submittedAt: string;
  /** The computer it was submitted on. */
  device: string | null;
  status: ImageReviewStatus;
  /** The owner's words: always on approved_with_note and returned; null otherwise. */
  comment: string | null;
  decidedAt: string | null;
  /** The computer the deciding record was made on. */
  decidedOn: string | null;
};

/** This computer's copy of the image: the submitted file, missing here, or a different file now. */
export type ImageFileState = "ok" | "missing" | "changed";

/**
 * The owner's list entry. `file` is checked (resolved and hashed) only for a pending image -- the only kind he can approve; an
 * answered or withdrawn image is `null` (not checked: the list never re-hashes the channel's whole history).
 */
export type OwnerImageView = ImageReviewView & { file: ImageFileState | null };

/** A file the ports resolved inside the channel workspace (absolute: never sent to the browser or an agent). */
export type ResolvedImageFile = { path: string; bytes: number };

export type ImageReviewsPorts = {
  store: {
    read(channelId: string): Promise<ImageReviewsSnapshot>;
    addImage(channelId: string, image: ImageReviewImage): Promise<void>;
    addDecision(channelId: string, decision: ImageReviewDecision): Promise<void>;
  };
  /** Whether the channel is connected on this computer (Settings → Channels). */
  isChannelConnected(channelId: string): Promise<boolean>;
  /** This computer's workspace folder of the channel, or null when none is set. */
  workspace(channelId: string): Promise<string | null>;
  /** The shared workspace rule (`review-items.resolveReviewFile`): a regular file strictly inside the workspace's real path. */
  resolveFile(workspace: string, relativePath: string): Promise<({ ok: true } & ResolvedImageFile) | { ok: false; reason: string }>;
  /** The image's real format and size by its header; null when it cannot be read as an image here. */
  probeImage(absolutePath: string): Promise<{ format: string; width: number; height: number } | null>;
  /** The file's SHA-256 (hex). */
  hashFile(absolutePath: string): Promise<string>;
  /** A JPEG preview of the image (large grid thumbnail); null when none can be made (the caller sends the original). */
  preview(absolutePath: string): Promise<Uint8Array | null>;
  /** Throws while the app is paused for a device handoff or recovery (the device mutation gate). */
  assertDeviceAvailable(): Promise<void>;
  deviceLabel(): Promise<string | null>;
  now(): Date;
  randomId(): string;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** An owner decision, recorded on the computer it was made on. */
  audit(entry: { channelId: string; imageId: string; detail: Record<string, unknown> }): Promise<void>;
  /** ADR 0066: "the owner just decided" -- the review-notify writer runs in a moment. Optional, never throws, never awaited. */
  notifyOwnerDecision?(): void;
};
