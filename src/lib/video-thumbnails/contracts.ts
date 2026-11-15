// BL-255 (ADR 0069): replace the custom thumbnail of a video already on YouTube -- the owner (Web UI) and the Producer (its own
// endpoint), any video of the channel (owner msgs 4380/4383). This module writes `thumbnails.set` and nothing else of the video.
import type { ResolvedCredentials } from "@/lib/shared-domain";
import type { BackupRecord, BackupSnapshot, BackupHealth } from "@/lib/backup/contracts";
import type { VideoThumbnailState } from "@/lib/youtube-read-gateway";

export { DomainError, isDomainError } from "@/lib/shared-domain";
export type { VideoThumbnailState };

/** `thumbnails.set`: "Maximum file size: 2MB" (YouTube Data API reference). */
export const THUMBNAIL_REPLACE_MAX_BYTES = 2 * 1024 * 1024;
/** 1 read before + 50 for `thumbnails.set` + 1 read-back (`src/lib/youtube-quota/costs.ts`). */
export const THUMBNAIL_REPLACE_UNITS = 52;

export type ThumbnailActor = { kind: "owner"; userId: string } | { kind: "producer"; tokenId: string };

export type ThumbnailReplaceInput = {
  channelId: string;
  videoId: string;
  /** Relative to the channel's workspace, under `04 Videos/`. */
  path: string;
  dryRun?: boolean;
};

export type ThumbnailReplaceResult = {
  channelId: string;
  videoId: string;
  path: string;
  dryRun: boolean;
  file: { bytes: number; contentType: "image/jpeg" | "image/png"; sha256: string };
  before: { hasCustomThumbnail: boolean | null; privacyStatus: string | null; publishAt: string | null; url: string | null };
  units: number;
  /** Set only when written. */
  written: boolean;
  backupPath: string | null;
  verified: boolean | null;
  verificationDetail: string | null;
  after: { hasCustomThumbnail: boolean | null; privacyStatus: string | null; publishAt: string | null; url: string | null } | null;
};

export type ThumbnailWriteCredentials = { credentialRef: { userId: string }; credentials: ResolvedCredentials };

export type VideoThumbnailsDeps = {
  /** The credentials used for this channel's writes: the owner's own, or (Producer) the channel's connected user. */
  credentials(channelId: string, actor: ThumbnailActor): Promise<ThumbnailWriteCredentials>;
  /** The image under `04 Videos/` of the channel's workspace, through the package-preview rule; null when it is not one. */
  readFile(channelId: string, relativePath: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  readVideo(credentials: ResolvedCredentials, videoId: string): Promise<VideoThumbnailState | null>;
  /** True while this computer's upload of the video has not yet run its own thumbnail step. */
  uploadThumbnailStepPending(channelId: string, videoId: string): Promise<boolean>;
  downloadImage(url: string): Promise<{ bytes: Buffer; contentType: string } | null>;
  backup: {
    checkInfrastructureHealth(): Promise<BackupHealth>;
    captureBackup(args: { channelId: string; operationId: string; videoId: string; snapshot: BackupSnapshot }): Promise<BackupRecord>;
  };
  assertWriteChannel(args: { channelId: string } & ThumbnailWriteCredentials): Promise<void>;
  /** The one write: checks Live writes immediately before the gateway's `thumbnails.set` (adapter). */
  setThumbnail(credentials: ResolvedCredentials, videoId: string, image: { mimeType: "image/jpeg" | "image/png"; bytes: Buffer }): Promise<void>;
  audit(args: { channelId: string; videoId: string; eventType: "BACKUP" | "RESULT" | "VERIFICATION"; detail: Record<string, unknown> }): Promise<void>;
  /** The stored copy's thumbnails, from the read-back. */
  storeThumbnails(channelId: string, videoId: string, thumbnails: VideoThumbnailState["thumbnails"]): Promise<void>;
  newOperationId(): string;
};
