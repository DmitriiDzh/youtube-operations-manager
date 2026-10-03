// BL-118 (slice D) -- week / month buckets over a channel's daily rows, so an agent can ask for a compact answer. Pure; the four channel-level
// metrics are all additive counts, so a bucket is a plain sum (a ratio metric would have to be recomputed from its parts, never averaged).

export type DailyChannelRow = {
  date: string;
  views: number;
  estimatedMinutesWatched: number;
  subscribersGained: number;
  subscribersLost: number;
};

export type Granularity = "day" | "week" | "month";

export type ChannelBucket = {
  /** First and last calendar day of the bucket, clipped to the requested range. */
  periodStart: string;
  periodEnd: string;
  /** Calendar days from periodStart to periodEnd inclusive. */
  calendarDays: number;
  /** True when the calendar week/month extends outside the requested range (an edge bucket that is only part of its week/month). */
  partialBucket: boolean;
  views: number;
  estimatedMinutesWatched: number;
  subscribersGained: number;
  subscribersLost: number;
};

const DAY_MS = 86_400_000;
const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Monday (UTC calendar) of the week containing `date`, and the Sunday that ends it. */
function weekBounds(date: string): { start: string; end: string } {
  const ms = toMs(date);
  const dayOfWeek = new Date(ms).getUTCDay(); // 0 = Sunday
  const sinceMonday = (dayOfWeek + 6) % 7;
  return { start: toDate(ms - sinceMonday * DAY_MS), end: toDate(ms - sinceMonday * DAY_MS + 6 * DAY_MS) };
}

function monthBounds(date: string): { start: string; end: string } {
  const [year, month] = date.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start, end };
}

/**
 * Sums `daily` into calendar weeks (Monday-Sunday) or months. A bucket is created for every week/month that overlaps the requested range,
 * including ones with no rows (all zeros): the response size stays small without hiding a quiet week. Edge buckets are clipped to the range
 * and flagged `partialBucket`.
 */
export function bucketDailyRows(args: {
  daily: readonly DailyChannelRow[];
  granularity: "week" | "month";
  startDate: string;
  endDate: string;
}): ChannelBucket[] {
  const bounds = args.granularity === "week" ? weekBounds : monthBounds;
  const buckets = new Map<string, ChannelBucket>();

  for (let ms = toMs(args.startDate); ms <= toMs(args.endDate); ms += DAY_MS) {
    const { start, end } = bounds(toDate(ms));
    if (buckets.has(start)) continue;
    const periodStart = start < args.startDate ? args.startDate : start;
    const periodEnd = end > args.endDate ? args.endDate : end;
    buckets.set(start, {
      periodStart,
      periodEnd,
      calendarDays: Math.round((toMs(periodEnd) - toMs(periodStart)) / DAY_MS) + 1,
      partialBucket: start < args.startDate || end > args.endDate,
      views: 0,
      estimatedMinutesWatched: 0,
      subscribersGained: 0,
      subscribersLost: 0,
    });
  }

  for (const row of args.daily) {
    if (row.date < args.startDate || row.date > args.endDate) continue;
    const bucket = buckets.get(bounds(row.date).start);
    if (!bucket) continue;
    bucket.views += row.views;
    bucket.estimatedMinutesWatched += row.estimatedMinutesWatched;
    bucket.subscribersGained += row.subscribersGained;
    bucket.subscribersLost += row.subscribersLost;
  }

  return [...buckets.values()].sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1));
}

export type PreviousPeriodStatus = "full" | "partial" | "predates_channel";

/**
 * Whether the comparison period existed at all (BL-118): entirely before the channel was created => `predates_channel` (the totals are
 * meaningless, not zero), starting before it but ending on/after it => `partial`, otherwise `full`. An unknown channel start can not be
 * judged and is treated as `full` (never guessed).
 */
export function classifyPreviousPeriod(args: {
  previousStartDate: string;
  previousEndDate: string;
  channelStartDate: string | null;
}): PreviousPeriodStatus {
  if (!args.channelStartDate) return "full";
  if (args.previousEndDate < args.channelStartDate) return "predates_channel";
  if (args.previousStartDate < args.channelStartDate) return "partial";
  return "full";
}

/** The status plus the sentence that explains it (shared by the agent tool and the Web UI so both say the same thing). */
export function describePreviousPeriod(args: {
  previousStartDate: string;
  previousEndDate: string;
  channelStartDate: string | null;
}): { status: PreviousPeriodStatus; note: string } {
  const status = classifyPreviousPeriod(args);
  const { previousStartDate, previousEndDate, channelStartDate } = args;
  const note =
    status === "predates_channel"
      ? `The comparison period (${previousStartDate} to ${previousEndDate}) ended before the channel was created (${channelStartDate}); there is nothing to compare with, so previousTotals is null (not zero).`
      : status === "partial"
        ? `The channel was created on ${channelStartDate}, inside the comparison period (${previousStartDate} to ${previousEndDate}); previousTotals covers only the days after it existed.`
        : channelStartDate === null
          ? "The channel's creation date is not known yet (not synced since this was added), so whether the comparison period existed could not be checked."
          : "The comparison period lies fully inside the channel's lifetime.";
  return { status, note };
}
