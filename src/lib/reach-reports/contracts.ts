import { DomainError, type CredentialRef, type DomainErrorCode, type DomainErrorShape, type ResolvedCredentials } from "@/lib/shared-domain";

export { DomainError };
export type { CredentialRef, DomainErrorCode, DomainErrorShape, ResolvedCredentials };

/**
 * BL-114 (docs/decisions/0014-youtube-reporting-api-gateway-child.md). The Reach "basic" report: thumbnail
 * impressions and click-through rate per video per day. (The "combined" report -- by traffic source and
 * device -- is a later slice.)
 */
export const REACH_BASIC_REPORT_TYPE_ID = "channel_reach_basic_a1";
export const REACH_JOB_NAME = "YTOM reach basic";

/** The exact CSV column names of `channel_reach_basic_a1` (developers.google.com/youtube/reporting/v1/reports/channel_reports). */
export const REACH_BASIC_COLUMNS = {
  date: "date",
  channelId: "channel_id",
  videoId: "video_id",
  impressions: "video_thumbnail_impressions",
  ctr: "video_thumbnail_impressions_ctr",
} as const;

export type ReachRow = {
  /** YYYY-MM-DD -- the report's own day, never converted to another timezone. */
  date: string;
  videoId: string;
  impressions: number;
  /** As the report gave it; `null` when the cell was empty. Never fabricated as 0. */
  ctr: number | null;
};

export type SyncReachFailure = { reportId: string; error: string };

export type SyncReachReportsResult = {
  skipped: false;
  jobId: string;
  /** True only if THIS call created the job on Google's side. */
  jobCreated: boolean;
  filesListed: number;
  filesImported: number;
  /** A file whose period already had a same-or-newer file: recorded, data untouched. */
  filesSuperseded: number;
  rowsImported: number;
  /** Files that could not be downloaded/parsed; not recorded, so the next sync retries them. */
  failures: SyncReachFailure[];
};

/** `onlyIfDue` and the job was checked less than `MIN_SYNC_INTERVAL_HOURS` ago: nothing was called. */
export type SyncReachReportsSkipped = { skipped: true; reason: "checked_recently"; lastCheckedAt: string };

/** The automatic (dashboard-mount) sync calls Google at most this often per channel. */
export const MIN_SYNC_INTERVAL_HOURS = 6;

export type ReachState =
  /** No reporting job exists for this channel yet. */
  | "no_job"
  /** A job exists but Google has not produced (or this app has not imported) a file yet. NOT zero data. */
  | "waiting_for_first_report"
  | "ready";

export type ReachDailyPoint = { date: string; impressions: number; ctr: number | null };
export type ReachVideoPoint = { videoId: string; impressions: number; ctr: number | null };

export type GetChannelReachResult = {
  channelId: string;
  state: ReachState;
  jobCreatedAt: string | null;
  coverage: { firstDate: string | null; lastDate: string | null; importedFiles: number };
  startDate: string;
  endDate: string;
  /** Days with no data are ABSENT, never zero-filled. */
  daily: ReachDailyPoint[];
  /** Top videos by impressions in the range (at most `TOP_VIDEOS_LIMIT`). */
  videos: ReachVideoPoint[];
  /** Impressions-weighted over the whole range; `null` ctr when no row carried one. */
  totals: { impressions: number; ctr: number | null };
  /** Echo of the `videoId` filter when one was given (every figure above is then over that video only). */
  videoId?: string;
  /** Present only with `groupBy: "video_day"`: the stored rows as they are, oldest day first within each video, videos in id order. */
  videoDaily?: ReachVideoDayPoint[];
  videoDailyTruncated?: boolean;
};

export const TOP_VIDEOS_LIMIT = 50;

/** `groupBy: "video_day"` returns at most this many rows; `videoDailyTruncated` says when more existed (narrow the range or pass a videoId). */
export const MAX_VIDEO_DAY_ROWS = 5000;

export type ReachVideoDayPoint = { videoId: string; date: string; impressions: number; ctr: number | null };

/** Google produces the first report file up to this long after a job is created (ADR 0014). */
export const FIRST_REPORT_EXPECTED_WITHIN_HOURS = 48;
/** At most this many report files are listed in the status payload (Google keeps ~60 daily files). */
export const STATUS_FILES_LIMIT = 90;

export type ReachSyncAttemptView = {
  at: string;
  /** `ok`, `partial` (some files failed and are retried) or `failed` (the sync stopped before importing). */
  outcome: "ok" | "partial" | "failed";
  error: string | null;
  filesListed: number;
  filesImported: number;
  failures: SyncReachFailure[];
};

export type ReachFileView = {
  reportId: string;
  /** Google's own period of the file, RFC 3339, as returned. */
  startTime: string;
  endTime: string;
  createTime: string;
  rowCount: number;
  /** `imported`, or `superseded` (a same-or-newer file already covered the period). */
  status: string;
  importedAt: string;
};

/**
 * Everything the Analytics card shows about the Reporting job and its files. Local data only -- no Google
 * call. `null` fields mean "not known yet", never a fabricated value.
 */
export type GetReachStatusResult = {
  channelId: string;
  job: { jobId: string; createdAt: string | null } | null;
  /** createTime + 48h; `null` when the job's creation time is unknown. */
  firstFileExpectedBy: string | null;
  /** No file imported yet AND the 48h window has passed: not normal, worth the owner's attention. */
  firstFileOverdue: boolean;
  lastAttempt: ReachSyncAttemptView | null;
  /** Earliest time the automatic (dashboard) sync will call Google again; `null` if it never ran. */
  nextAutoCheckAt: string | null;
  importedFiles: number;
  files: ReachFileView[];
};
