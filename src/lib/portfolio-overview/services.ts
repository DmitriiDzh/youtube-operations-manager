import type { PortfolioChannelRow, PortfolioChannelSource, PortfolioOverview, PortfolioRange } from "./contracts";

const METRIC_FIELDS = {
  views: "views",
  watchMinutes: "estimatedMinutesWatched",
  subscribersGained: "subscribersGained",
  subscribersLost: "subscribersLost",
} as const;

function sumMetric(source: PortfolioChannelSource, range: PortfolioRange, metricName: string): number | null {
  const rows = source.metrics.filter((row) => row.metricName === metricName && row.metricDate >= range.startDate && row.metricDate <= range.endDate);
  return rows.length === 0 ? null : rows.reduce((total, row) => total + row.metricValue, 0);
}

/** Adds up one channel's stored data for the range (pure). */
export function buildPortfolioRow(source: PortfolioChannelSource, range: PortfolioRange): PortfolioChannelRow {
  const days = new Set(source.metrics.filter((row) => row.metricDate >= range.startDate && row.metricDate <= range.endDate).map((row) => row.metricDate));
  const hasData = days.size > 0;
  const reachReady = source.reach?.state === "ready";
  return {
    channelId: source.channelId,
    title: source.title,
    analytics: {
      daysWithData: days.size,
      views: hasData ? sumMetric(source, range, METRIC_FIELDS.views) : null,
      watchMinutes: hasData ? sumMetric(source, range, METRIC_FIELDS.watchMinutes) : null,
      subscribersGained: hasData ? sumMetric(source, range, METRIC_FIELDS.subscribersGained) : null,
      subscribersLost: hasData ? sumMetric(source, range, METRIC_FIELDS.subscribersLost) : null,
    },
    reach: {
      state: source.reach ? source.reach.state : "unavailable",
      impressions: reachReady ? source.reach!.impressions : null,
      ctr: reachReady ? source.reach!.ctr : null,
    },
    uploads: source.videoPublishedAt.filter((publishedAt) => {
      const time = Date.parse(publishedAt);
      if (Number.isNaN(time)) return false;
      const day = new Date(time).toISOString().slice(0, 10);
      return day >= range.startDate && day <= range.endDate;
    }).length,
    freshness: {
      lastVideoSyncAt: source.lastVideoSyncAt?.toISOString() ?? null,
      lastAnalyticsCollectedAt: source.lastAnalyticsCollectedAt?.toISOString() ?? null,
      reachCoveredThrough: source.reach?.coveredThrough ?? null,
    },
  };
}

export type PortfolioOverviewDeps = {
  listChannels(): Promise<Array<{ channelId: string; title: string }>>;
  loadChannel(channel: { channelId: string; title: string }, range: PortfolioRange): Promise<PortfolioChannelSource>;
};

export function createPortfolioOverviewServices(deps: PortfolioOverviewDeps) {
  return {
    /** Every connected channel's row for the range, in the order the channels are listed. */
    async getOverview(range: PortfolioRange): Promise<PortfolioOverview> {
      const channels = await deps.listChannels();
      const sources = await Promise.all(channels.map((channel) => deps.loadChannel(channel, range)));
      return { ...range, source: "local", channels: sources.map((source) => buildPortfolioRow(source, range)) };
    },
  };
}

export type PortfolioOverviewServices = ReturnType<typeof createPortfolioOverviewServices>;
