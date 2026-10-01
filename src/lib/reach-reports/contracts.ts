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
};

export const TOP_VIDEOS_LIMIT = 50;
