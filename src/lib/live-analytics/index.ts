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
  return {
    async summary(channelId: string, days: number): Promise<LiveSummary & { range: { from: string; to: string; days: number } }> {
      const to = deps.now();
      const from = new Date(to.getTime() - days * DAY_MS);
      const [samples, events] = await Promise.all([deps.samples(channelId, from, to), deps.runExits(channelId, from)]);
      const inRange = events.filter((event) => event.at < to.getTime());
      const summary = summariseLive({ samples, events: inRange });
      const pulls = await deps.pulls(summary.broadcasts.map((b) => b.broadcastId));
      return { range: { from: from.toISOString(), to: to.toISOString(), days }, ...summary, analytics: pulls.map(viewOf) };
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
