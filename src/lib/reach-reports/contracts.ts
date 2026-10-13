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

/**
 * BL-181 (FO-REQ-0020, docs/roadmap/plans/REPORTING_BASIC_PLAN.md): the basic user-activity and traffic-source reports, synced
 * next to Reach so their lag behind the Analytics API can be measured (stage 1). Each computer downloads its own: they are not in
 * the cross-computer analytics file, whose peer importer only knows Reach rows.
 */
export const BASIC_REPORT_TYPE_ID = "channel_basic_a3";
export const BASIC_JOB_NAME = "YTOM basic";
export const TRAFFIC_SOURCE_REPORT_TYPE_ID = "channel_traffic_source_a3";
export const TRAFFIC_SOURCE_JOB_NAME = "YTOM traffic source";

/**
 * Google's column names for `channel_basic_a3` (developers.google.com/youtube/reporting/v1/reports/channel_reports, read
 * 2026-10-13). Only the dimensions and metrics stored here; the card and annotation metrics are ignored.
 */
export const BASIC_COLUMNS = {
  date: "date",
  channelId: "channel_id",
  videoId: "video_id",
  views: "views",
  engagedViews: "engaged_views",
  redViews: "red_views",
  watchTimeMinutes: "watch_time_minutes",
  redWatchTimeMinutes: "red_watch_time_minutes",
  likes: "likes",
  dislikes: "dislikes",
  comments: "comments",
  shares: "shares",
  subscribersGained: "subscribers_gained",
  subscribersLost: "subscribers_lost",
  videosAddedToPlaylists: "videos_added_to_playlists",
  videosRemovedFromPlaylists: "videos_removed_from_playlists",
} as const;

/** A file without one of these is refused whole; every other stored metric may be missing (its value is then `null`). */
export const BASIC_REQUIRED_COLUMNS = ["date", "channel_id", "video_id", "views", "watch_time_minutes"] as const;

/** `channel_traffic_source_a3`: the same dimensions plus `traffic_source_type` (a numeric code) and `traffic_source_detail`. */
export const TRAFFIC_SOURCE_COLUMNS = {
  date: "date",
  channelId: "channel_id",
  videoId: "video_id",
  trafficSourceType: "traffic_source_type",
  views: "views",
  engagedViews: "engaged_views",
  watchTimeMinutes: "watch_time_minutes",
} as const;

export const TRAFFIC_SOURCE_REQUIRED_COLUMNS = ["date", "channel_id", "video_id", "traffic_source_type", "views", "watch_time_minutes"] as const;

export type BasicMetricName =
  | "views"
  | "engagedViews"
  | "redViews"
  | "watchTimeMinutes"
  | "redWatchTimeMinutes"
  | "likes"
  | "dislikes"
  | "comments"
  | "shares"
  | "subscribersGained"
  | "subscribersLost"
  | "videosAddedToPlaylists"
  | "videosRemovedFromPlaylists";

/**
 * One video's day, summed over the file's rows (country, subscribed status, live or on demand), anonymised rows included. `videoId`
 * `""` is the channel-level and deleted-video remainder, which belongs in channel totals. A metric no row of the group carried is
 * `null`, never 0 (the channel-level row has only the subscriber counts).
 */
export type BasicDailyRow = { date: string; videoId: string } & Record<BasicMetricName, number | null>;

export type TrafficSourceMetricName = "views" | "engagedViews" | "watchTimeMinutes";

/** One video's day for one traffic source code, summed over the file's rows (the `traffic_source_detail` values included). */
export type TrafficSourceDailyRow = { date: string; videoId: string; trafficSourceType: number } & Record<TrafficSourceMetricName, number | null>;

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
  /** BL-181: the other report types synced in the same call (absent when none is configured). */
  otherReports?: OtherReportSyncResult[];
};

/**
 * BL-181: one non-Reach report type's part of a sync (basic user activity, traffic sources). Each runs after Reach in its own
 * try/catch with its own attempt row, so it never changes Reach's result. `error` is set when the type stopped before importing.
 */
export type OtherReportSyncResult = {
  reportTypeId: string;
  outcome: "ok" | "partial" | "failed";
  error: string | null;
  jobCreated: boolean;
  filesListed: number;
  filesImported: number;
  filesSuperseded: number;
  rowsImported: number;
  failures: SyncReachFailure[];
};

/** `onlyIfDue` and the job was checked less than `MIN_SYNC_INTERVAL_HOURS` ago: nothing was called. */
export type SyncReachReportsSkipped =
  | { skipped: true; reason: "checked_recently"; lastCheckedAt: string }
  /** BL-141: an automatic sync of the same channel is already running in this process. */
  | { skipped: true; reason: "in_progress" };

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

/**
 * BL-166: one video's Reach over one window. `daysWithData` counts the days of the window with a stored row for that video; with 0,
 * `impressions` is 0 and `ctr` null, and the pair means "nothing imported", never "no impressions".
 */
export type VideoWindowReach = { videoId: string; startDate: string; endDate: string; daysWithData: number; impressions: number; ctr: number | null };

export type GetVideoWindowsReachResult = { channelId: string; state: ReachState; windows: VideoWindowReach[] };

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
  /**
   * BL-181 (FO-REQ-0020 §2.4): `createTime` minus `endTime` in hours, one decimal -- how long after its Pacific day ended Google
   * created the file. `null` when a time cannot be read.
   */
  lagHours: number | null;
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
  /** BL-181: Reach's first file per day and its lag (see `FirstFileLagView`), newest day first. */
  firstFileLag: FirstFileLagView[];
  /** BL-181: the same status for each other report type this app syncs (basic user activity, traffic sources). */
  otherReports?: ReportTypeStatusView[];
};

/**
 * BL-181: the first file Google created for one day, after the job existed (history files made right after a job is created are left
 * out: their lag says nothing about freshness). `date` is the report's Pacific day (the UTC date of `startTime`).
 */
export type FirstFileLagView = { date: string; createTime: string; lagHours: number };

export type ReportTypeStatusView = {
  reportTypeId: string;
  job: { jobId: string; createdAt: string | null } | null;
  lastAttempt: ReachSyncAttemptView | null;
  importedFiles: number;
  files: ReachFileView[];
  /** Newest day first. */
  firstFileLag: FirstFileLagView[];
};
