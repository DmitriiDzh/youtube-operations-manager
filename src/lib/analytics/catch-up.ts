import { enumerateDates } from "./period";

// BL-118 (docs/roadmap/plans/ANALYTICS_AGENT_FEEDBACK_PLAN.md) -- pure rules for the automatic history catch-up: closing the gap between
// the start of a channel's history and what has actually been collected. No I/O.

const DAY_MS = 86_400_000;

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The first day to ask the Analytics API for a video: ONE DAY BEFORE its publish date (a day early costs nothing and the API simply
 * returns no row; a day late would lose day 0). `publishedAt` is YouTube's RFC 3339 time; its UTC date part is used.
 */
export function videoPublishFloor(publishedAt: string): string {
  return shiftDate(publishedAt.slice(0, 10), -1);
}

/**
 * The range to query for one video inside a requested window: the window's start, but never before the video's publish floor. Null
 * when the video did not exist yet by the window's end (nothing to ask for, and it must not count as a skipped video).
 */
export function perVideoQueryRange(
  video: { publishedAt: string },
  window: { startDate: string; endDate: string }
): { from: string; to: string } | null {
  const floor = videoPublishFloor(video.publishedAt);
  const from = window.startDate > floor ? window.startDate : floor;
  return from > window.endDate ? null : { from, to: window.endDate };
}

/**
 * How far a video's contiguous history reaches after a query `[from, to]` made for window `startDate`.. : if the query reached the
 * publish floor, the history now runs from the publish date through `to`; if it extends an existing contiguous history, through `to`;
 * otherwise nothing can be claimed (a rolling window that does not touch the publish date proves nothing about the early days).
 */
export function nextVideoHistoryThrough(args: {
  prior: string | null;
  publishedAt: string;
  query: { from: string; to: string };
}): string | null {
  const floor = videoPublishFloor(args.publishedAt);
  const reachesPublish = args.query.from <= floor;
  const extendsPrior = args.prior !== null && args.query.from <= shiftDate(args.prior, 1);
  if (!reachesPublish && !extendsPrior) return null;
  const through = args.prior !== null && args.prior > args.query.to ? args.prior : args.query.to;
  return through;
}

export type VideoCatchUpRange = { videoId: string; from: string; to: string };

/**
 * Videos whose history is not collected up to the day before the rolling window starts: for each, the range still missing. A video with
 * no recorded history is asked from its publish floor; one with history is asked from the day after it ends. Videos published on or
 * after the rolling window's start are fully inside the rolling window and need nothing here.
 */
export function planVideoHistoryCatchUp(args: {
  videos: ReadonlyArray<{ videoId: string; publishedAt: string }>;
  historyThrough: ReadonlyMap<string, string>;
  rollingStart: string;
}): VideoCatchUpRange[] {
  const to = shiftDate(args.rollingStart, -1);
  const out: VideoCatchUpRange[] = [];
  for (const video of args.videos) {
    if (!video.publishedAt) continue;
    const floor = videoPublishFloor(video.publishedAt);
    const prior = args.historyThrough.get(video.videoId) ?? null;
    const from = prior === null ? floor : shiftDate(prior, 1);
    if (from <= to) out.push({ videoId: video.videoId, from, to });
  }
  return out;
}

/**
 * The span of channel-level dates (before the rolling window) that no channel-level collection run covers: from the first uncovered date to
 * the last one, or null when everything from `historyStart` is covered. `historyStart` is the channel's creation date, else its earliest
 * video's publish date; null when neither is known (nothing can be planned).
 */
export function planChannelCatchUp(args: {
  historyStart: string | null;
  rollingStart: string;
  runs: ReadonlyArray<{ requestedStartDate: string; requestedEndDate: string; channelLevel: boolean }>;
}): { startDate: string; endDate: string } | null {
  if (!args.historyStart) return null;
  const end = shiftDate(args.rollingStart, -1);
  if (args.historyStart > end) return null;
  const covered = args.runs.filter((r) => r.channelLevel);
  const uncovered = enumerateDates(args.historyStart, end).filter(
    (date) => !covered.some((r) => date >= r.requestedStartDate && date <= r.requestedEndDate)
  );
  if (uncovered.length === 0) return null;
  return { startDate: uncovered[0], endDate: uncovered[uncovered.length - 1] };
}

/** The earliest date history can start: the channel's creation date, else the earliest video publish date, else null. */
export function resolveHistoryStart(args: { channelStartDate: string | null; videos: ReadonlyArray<{ publishedAt: string }> }): string | null {
  if (args.channelStartDate) return args.channelStartDate;
  const dates = args.videos.map((v) => v.publishedAt.slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return dates[0] ?? null;
}
