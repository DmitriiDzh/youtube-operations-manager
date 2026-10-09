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
  // Appended 2026-10-04 (operator request): raw values from YouTube, empty when unknown (never 0); no Shorts flag is derived here.
  "durationSeconds",
  "liveBroadcastContent",
] as const;

export type ExportDataset = "research_channel_snapshots" | "research_video_snapshots" | "own_video_snapshots";
export type ExportFormat = "csv" | "json";

/** How deep one watchlist channel's uploads are collected and how far it has got (operator request 2026-10-04). */
export type ResearchCollectionProgress = {
  /** The effective cap of distinct videos kept per channel (per-channel override, else the global default, else 50). */
  maxVideosPerChannel: number;
  /** `YYYY-MM-DD`: videos published before this day are not collected; `null` = no date limit. */
  publishedAfter: string | null;
  /** Distinct videos stored for the channel right now (inside the 30-day window) = `uniqueVideoCount`. */
  videosStored: number;
  /** True once a collection finished under the settings in force (cap reached, date reached, or the playlist ended). */
  complete: boolean;
  /** Why it finished: `cap`, `date` or `exhausted` (the channel has no more uploads); `null` while `complete` is false. */
  completeReason: "cap" | "date" | "exhausted" | null;
};

/** What the export reads about one watchlist channel -- a subset of `getWatchlistEntryContext`, already narrowed to what the caller may see. */
/** BL-163 (FO-REQ-0014 §A1): a watchlist entry's activity -- the raw newest upload date (never "days since": III.E.4.h), inactive, pause. */
export type WatchlistActivityForExport = { latestUploadPublishedAt: string | null; inactive: boolean; pausedAt: string | null; pausedReason: "inactive" | "owner" | null };

export type WatchlistContextForExport = {
  channel: { channelId: string; handleOrUrl: string | null; activity?: WatchlistActivityForExport };
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
    durationSeconds?: number | null;
    liveBroadcastContent?: string | null;
    source: string;
  }>;
  dataQualityFlags: string[];
  collectionProgress: ResearchCollectionProgress;
};

export type OwnVideoForExport = {
  videoId: string;
  publishedAt: string;
  privacyStatus: string;
  title: string;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  durationSeconds?: number | null;
  liveBroadcastContent?: string | null;
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
  /**
   * BL-163 (FO-REQ-0014 §A1): the newest PUBLISH date among the stored video snapshots (`null` = not known), whether that makes the
   * entry inactive (older than the owner's "inactive after N months"), and its pause (a paused entry is not collected).
   */
  latestUploadPublishedAt: string | null;
  inactive: boolean;
  pausedAt: string | null;
  pausedReason: "inactive" | "owner" | null;
  evidenceCount: number;
  dataQualityFlags: string[];
  /** Collection depth and progress of this channel (see `ResearchCollectionProgress`). */
  collection: ResearchCollectionProgress;
};

export type ListResearchOverviewResult = {
  total: number;
  offset: number;
  limit: number;
  channels: ResearchOverviewEntry[];
  /** `offset` for the next page, or `null` when this page is the last. */
  nextOffset: number | null;
};
