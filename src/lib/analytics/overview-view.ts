import { PROVISIONAL_WINDOW_DAYS } from "./data-quality";
import type { GetChannelOverviewResult } from "./contracts";
import { bucketDailyRows, describePreviousPeriod, type ChannelBucket, type Granularity, type PreviousPeriodStatus } from "./granularity";

/**
 * What the Web UI's Overview needs on top of `getChannelOverview` (BL-120): where the numbers came from, whether the comparison period
 * existed, which days are still provisional, and week/month buckets for the chart. Pure -- built from an overview that was already read
 * and the channel's creation date, so it costs no extra API call.
 */
export type ChannelOverviewView = GetChannelOverviewResult & {
  channelStartDate: string | null;
  previousPeriod: { status: PreviousPeriodStatus; note: string };
  /** Days from this date on were collected inside YouTube's reporting lag and may still change. */
  provisionalFromDate: string;
  granularity: Granularity;
  /** `null` for `day` (use `daily`). */
  buckets: ChannelBucket[] | null;
};

export function buildChannelOverviewView(args: {
  overview: GetChannelOverviewResult;
  channelStartDate: string | null;
  granularity: Granularity;
  now: Date;
}): ChannelOverviewView {
  const { overview, channelStartDate, granularity, now } = args;
  return {
    ...overview,
    channelStartDate,
    previousPeriod: describePreviousPeriod({
      previousStartDate: overview.previousStartDate,
      previousEndDate: overview.previousEndDate,
      channelStartDate,
    }),
    provisionalFromDate: new Date(now.getTime() - PROVISIONAL_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10),
    granularity,
    buckets:
      granularity === "day"
        ? null
        : bucketDailyRows({ daily: overview.daily, granularity, startDate: overview.startDate, endDate: overview.endDate }),
  };
}
