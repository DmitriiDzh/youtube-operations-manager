// ---------------------------------------------------------------------------
// BL-213/BL-214 (docs/roadmap/plans/LIVE_ANALYTICS_PLAN.md): the live-stream summary -- one vocabulary for the Web UI's
// «Эфиры» card and the producer's read-only tool. A shared leaf module (AGENTS.md §M): pure, it imports no feature module;
// its callers read the samples (BL-211) and the stream's events and hand them in.
// ---------------------------------------------------------------------------

export const DAY_MS = 86_400_000;
/** An interval between two samples longer than this is a data gap (the poll runs every 5 minutes, every minute after a start). */
export const MAX_GAP_MS = 10 * 60_000;
export const RANGE_DAYS_DEFAULT = 7;
export const RANGE_DAYS_MAX = 90;

/** The range in whole days (1..90) from a query value; null when it is not one. Absent → the default week. */
export function parseRangeDays(value: string | null): number | null {
  if (value === null) return RANGE_DAYS_DEFAULT;
  if (!/^\d{1,3}$/.test(value)) return null;
  const days = Number(value);
  return days >= 1 && days <= RANGE_DAYS_MAX ? days : null;
}

export type LiveSummaryFigures = {
  samples: number;
  /** Time the broadcast was live, from counted intervals. */
  onAirMs: number;
  /** Time the stream was on but the broadcast not live (e.g. `ready`). */
  notLiveMs: number;
  /** Intervals longer than MAX_GAP_MS: nothing is known about them. */
  dataGaps: number;
  viewerHours: number;
  /** Time-weighted over the live time with a count; null when there is none. */
  averageViewers: number | null;
  peakViewers: number | null;
  /** Encoder runs that ended early (the helper restarted them). */
  interruptions: number;
};

export type LiveSummary = {
  totals: LiveSummaryFigures;
  /** UTC dates, oldest first. */
  days: Array<{ date: string } & LiveSummaryFigures>;
  /** UTC hours with samples, oldest first (the chart). */
  hours: Array<{ hour: string; averageViewers: number | null; peakViewers: number | null }>;
  /** By broadcast (a BL-205 segment is its own broadcast), in order of their first sample. */
  broadcasts: Array<{ broadcastId: string; firstSampleAt: number; lastSampleAt: number } & LiveSummaryFigures>;
  /** BL-212: YouTube Analytics of the broadcasts above that this computer pulled; null when not looked up. */
  analytics: BroadcastAnalyticsView[] | null;
};

// ---------------------------------------------------------------------------
// BL-212 (LIVE_ANALYTICS_PLAN.md stage 2): YouTube Analytics of an ended broadcast, pulled by this computer.
// ---------------------------------------------------------------------------

/** A broadcast counts as ended when its last sample is this old (the poll runs every 5 minutes while it is on). */
export const BROADCAST_ENDED_AFTER_MS = 60 * 60_000;
/** The second, final pull: after YouTube Analytics' reporting lag. */
export const FINAL_PULL_AFTER_MS = 4 * DAY_MS;
export const PULL_RETRY_AFTER_MS = 6 * 60 * 60_000;
export const PULL_MAX_ATTEMPTS = 5;
export const PULLS_PER_TICK = 4;
export const PULL_TICK_MS = 60 * 60_000;

/** ok; unsupported = YouTube refused the query (400); unavailable = the video is gone or not ours (403/404); error = anything else. */
export type ReportOutcome = "ok" | "unsupported" | "unavailable" | "error";
export type WatchTotals = { views: number | null; minutesWatched: number | null };

export type BroadcastAnalyticsData = {
  concurrent: { average: number | null; peak: number | null } | null;
  /** The "concurrent viewers" report by `livestreamPosition` (usually a minute): [position, average, peak]. */
  curve: Array<[number, number | null, number | null]> | null;
  live: WatchTotals | null;
  onDemand: WatchTotals | null;
  reports: { concurrent: ReportOutcome; curve: ReportOutcome; split: ReportOutcome };
};

export type BroadcastAnalyticsStatus = "collected" | "failed" | "unavailable";

export type BroadcastAnalyticsView = {
  broadcastId: string;
  status: BroadcastAnalyticsStatus;
  /** True after the pull that followed the reporting lag. */
  final: boolean;
  collectedAt: string | null;
  concurrent: BroadcastAnalyticsData["concurrent"];
  live: WatchTotals | null;
  onDemand: WatchTotals | null;
};
