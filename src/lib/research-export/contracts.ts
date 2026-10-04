import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/shared-domain";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError };

/**
 * Research export (`docs/roadmap/plans/RESEARCH_EXPORT_PLAN.md`, ADR 0019) -- the Manager writes flat, script-ready CSV/JSON files of the
 * research watchlist's snapshots (and our own channel's videos, in the same shape) into `99 Data Exchange/From YTM/` inside the operator-set channel
 * workspace folder, so a script can use them instead of an agent retyping tool output. The agent chooses neither the folder nor any
 * file name; it only asks for an export and gets back the paths, row counts and expiry.
 */

/** Stable column order of `research_channel_snapshots`. `channel` is the watchlist entry's handle/URL (channel id when it has none). */
export const CHANNEL_SNAPSHOT_COLUMNS = [
  "channel",
  "channelId",
  "observedAt",
  "subscriberCount",
  "viewCount",
  "videoCount",
  "hiddenSubscriberCount",
  "videoSnapshotCount",
  "evidenceCount",
  "dataQualityFlags",
  // Appended 2026-10-04 (operator request): existing columns keep their position and meaning.
  "uniqueVideoCount",
  "latestVideoSnapshotAt",
] as const;

/** Stable column order of `research_video_snapshots` and `own_video_snapshots` (the same shape on purpose: one comparison method). */
export const VIDEO_SNAPSHOT_COLUMNS = [
  "channel",
  "channelId",
  "videoId",
  "publishedAt",
  "observedAt",
  "viewCount",
  "likeCount",
  "commentCount",
  "title",
] as const;

export type ExportDataset = "research_channel_snapshots" | "research_video_snapshots" | "own_video_snapshots";
export type ExportFormat = "csv" | "json";

/** What the export reads about one watchlist channel -- a subset of `getWatchlistEntryContext`, already narrowed to what the caller may see. */
export type WatchlistContextForExport = {
  channel: { channelId: string; handleOrUrl: string | null };
  evidenceCount: number;
  channelSnapshots: Array<{
    observedAt: string;
    subscriberCount: number | null;
    viewCount: number | null;
    videoCount: number | null;
    hiddenSubscriberCount: boolean;
    source: string;
  }>;
  videoSnapshots: Array<{
    videoId: string;
    observedAt: string;
    viewCount: number | null;
    likeCount: number | null;
    commentCount: number | null;
    publishedAt: string | null;
    title: string | null;
    source: string;
  }>;
  dataQualityFlags: string[];
};

export type OwnVideoForExport = {
  videoId: string;
  publishedAt: string;
  privacyStatus: string;
  title: string;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  /** When this device last synced the video from YouTube -- the `observedAt` of the row. */
  lastSyncedAt: Date;
};

export type ExportedFile = {
  dataset: ExportDataset;
  format: ExportFormat;
  /** Absolute path of the written file (inside the channel's workspace folder, `99 Data Exchange/From YTM/`). */
  path: string;
  /** Data rows, header excluded -- equals the number of records the corresponding read tool returned. */
  rows: number;
  bytes: number;
  /** ISO time after which the Manager deletes the file itself; `null` = no expiry (our own channel's data). */
  expiresAt: string | null;
};

export type ExportResearchDataResult = {
  generatedAt: string;
  exportsDir: string;
  files: ExportedFile[];
  watchlistChannels: { exported: number; withoutSnapshots: string[] };
  retentionNote: string;
};

export type LedgerFileRecord = {
  id: string;
  channelId: string;
  exportsDir: string;
  fileName: string;
  dataset: ExportDataset;
  format: ExportFormat;
  rowCount: number;
  createdAt: Date;
  expiresAt: Date | null;
};

/** One watchlist channel in the compact bulk read: its newest stored channel snapshot (raw values as stored) plus row counts. */
export type ResearchOverviewEntry = {
  channelId: string;
  handleOrUrl: string | null;
  latestChannelSnapshot: {
    observedAt: string;
    subscriberCount: number | null;
    viewCount: number | null;
    videoCount: number | null;
    hiddenSubscriberCount: boolean;
  } | null;
  channelSnapshotCount: number;
  /** Stored video-snapshot ROWS (a video snapshotted in several runs counts several times); see `uniqueVideoCount` for videos. */
  videoSnapshotCount: number;
  /** Distinct `videoId` among the stored video snapshots (inside the 30-day window). */
  uniqueVideoCount: number;
  /** Newest `observedAt` among the stored video snapshots; `null` when there are none. */
  latestVideoSnapshotAt: string | null;
  evidenceCount: number;
  dataQualityFlags: string[];
};

export type ListResearchOverviewResult = {
  total: number;
  offset: number;
  limit: number;
  channels: ResearchOverviewEntry[];
  /** `offset` for the next page, or `null` when this page is the last. */
  nextOffset: number | null;
};
