import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { getStoredChannel, listLiveBroadcastAnalytics, listLiveStreamEventsOfKind, listLiveViewerSamples, listSampledLiveBroadcasts, upsertLiveBroadcastAnalytics } from "@/lib/db";
import { DomainError } from "@/lib/shared-domain";
import { getAuthenticatedYoutubeAnalytics, queryOwnVideoReport } from "@/lib/youtube-read-gateway";
import { createBroadcastAnalyticsCollector, type CollectorDeps, type StoredPull } from "./collect";
import { DAY_MS, type BroadcastAnalyticsData, type BroadcastAnalyticsStatus, type BroadcastAnalyticsView, type LiveSummary } from "./contracts";
import { summariseLive, type LiveEventInput, type LiveSampleInput } from "./summarise";

export * from "./contracts";
export { summariseLive, type LiveEventInput, type LiveSampleInput } from "./summarise";
export { createBroadcastAnalyticsCollector } from "./collect";

// BL-213 (LIVE_ANALYTICS_PLAN.md stage 3): a channel's live-stream summary over the last N days, from what this computer
// stored -- the viewer samples (BL-211) and the encoder's run exits. Local only: never a YouTube call.
export type LiveAnalyticsDeps = {
  samples(channelId: string, from: Date, to: Date): Promise<LiveSampleInput[]>;
  runExits(channelId: string, from: Date): Promise<LiveEventInput[]>;
  /** BL-212: what this computer pulled from YouTube Analytics for these broadcasts. */
  pulls(broadcastIds: string[]): Promise<StoredPull[]>;
  now(): Date;
};

function viewOf(row: StoredPull): BroadcastAnalyticsView {
  let data: BroadcastAnalyticsData | null = null;
  try {
    data = row.dataJson ? (JSON.parse(row.dataJson) as BroadcastAnalyticsData) : null;
  } catch {
    data = null;
  }
  return {
    broadcastId: row.broadcastId,
    status: row.status,
    final: row.final,
    collectedAt: row.collectedAt ? row.collectedAt.toISOString() : null,
    concurrent: data?.concurrent ?? null,
    live: data?.live ?? null,
    onDemand: data?.onDemand ?? null,
  };
}

const storedPull = (row: Awaited<ReturnType<typeof listLiveBroadcastAnalytics>>[number]): StoredPull => ({ ...row, status: row.status as BroadcastAnalyticsStatus });

function causeOf(detailJson: string): string | null {
  try {
    const cause = (JSON.parse(detailJson) as { cause?: unknown }).cause;
    return typeof cause === "string" ? cause : null;
  } catch {
    return null;
  }
}

export function defaultLiveAnalyticsDeps(): LiveAnalyticsDeps {
  return {
    samples: async (channelId, from, to) =>
      (await listLiveViewerSamples(channelId, from, to)).map((row) => ({ sampledAt: row.sampledAt.getTime(), broadcastId: row.broadcastId, viewers: row.viewers, lifeCycleStatus: row.lifeCycleStatus })),
    runExits: async (channelId, from) =>
      (await listLiveStreamEventsOfKind(channelId, "encoder_run_exit", from)).map((row) => ({ at: row.at.getTime(), kind: row.kind, cause: causeOf(row.detailJson) })),
    pulls: async (broadcastIds) => (await listLiveBroadcastAnalytics(broadcastIds)).map(storedPull),
    now: () => new Date(),
  };
}

export function createLiveAnalyticsCore(deps: LiveAnalyticsDeps = defaultLiveAnalyticsDeps()) {
  async function between(channelId: string, from: Date, to: Date): Promise<LiveSummary> {
    const [samples, events] = await Promise.all([deps.samples(channelId, from, to), deps.runExits(channelId, from)]);
    const summary = summariseLive({ samples, events: events.filter((event) => event.at < to.getTime()) });
    const pulls = await deps.pulls(summary.broadcasts.map((b) => b.broadcastId));
    return { ...summary, analytics: pulls.map(viewOf) };
  }
  return {
    between,
    async summary(channelId: string, days: number): Promise<LiveSummary & { range: { from: string; to: string; days: number } }> {
      const to = deps.now();
      const from = new Date(to.getTime() - days * DAY_MS);
      return { range: { from: from.toISOString(), to: to.toISOString(), days }, ...(await between(channelId, from, to)) };
    },
    /**
     * BL-214 (`producer_live_analytics`): each channel's summary over UTC dates [startDate, endDate] -- totals, days and broadcasts,
     * each broadcast with what YouTube Analytics gave (`youtube`, null until pulled) and `analyticsCollected` (the final pull after
     * the reporting lag is stored: deleting the recording loses nothing kept here). No hourly series.
     */
    async portfolio(input: { startDate: string; endDate: string }, channels: Array<{ channelId: string; title: string }>) {
      const from = new Date(`${input.startDate}T00:00:00.000Z`);
      const to = new Date(Date.parse(`${input.endDate}T00:00:00.000Z`) + DAY_MS);
      return {
        startDate: input.startDate,
        endDate: input.endDate,
        source: "local" as const,
        channels: await Promise.all(
          channels.map(async (channel) => {
            const summary = await between(channel.channelId, from, to);
            const pulls = new Map((summary.analytics ?? []).map((a) => [a.broadcastId, a]));
            return {
              channelId: channel.channelId,
              title: channel.title,
              totals: summary.totals,
              days: summary.days,
              broadcasts: summary.broadcasts.map((b) => {
                const pull = pulls.get(b.broadcastId) ?? null;
                return {
                  ...b,
                  firstSampleAt: new Date(b.firstSampleAt).toISOString(),
                  lastSampleAt: new Date(b.lastSampleAt).toISOString(),
                  youtube: pull ? { status: pull.status, final: pull.final, collectedAt: pull.collectedAt, concurrent: pull.concurrent, live: pull.live, onDemand: pull.onDemand } : null,
                  analyticsCollected: pull?.status === "collected" && pull.final,
                };
              }),
            };
          })
        ),
      };
    },
  };
}

/** The Google user a channel is connected with on this computer (Settings → Channels): the stream's own background reads. */
async function channelUserId(channelId: string): Promise<string> {
  const connected = (await createChannelConnectionsCore().listConnectedChannels()).some((channel) => channel.channelId === channelId);
  const userId = connected ? ((await getStoredChannel(channelId))?.connectedUserId ?? null) : null;
  if (!userId) throw new DomainError({ code: "unauthorized", message: "This channel is not connected on this computer (Settings → Channels)", details: { channelId } });
  return userId;
}

export function defaultCollectorDeps(): CollectorDeps {
  return {
    broadcasts: () => listSampledLiveBroadcasts(),
    stored: async (ids) => (await listLiveBroadcastAnalytics(ids)).map(storedPull),
    save: (row) => upsertLiveBroadcastAnalytics(row),
    query: async (args) => queryOwnVideoReport(await getAuthenticatedYoutubeAnalytics(await channelUserId(args.channelId)), args),
    now: () => new Date(),
  };
}

/** BL-212: the hourly pull of ended broadcasts' YouTube Analytics (instrumentation). */
export function createBroadcastAnalyticsCollectorCore() {
  return createBroadcastAnalyticsCollector(defaultCollectorDeps());
}
