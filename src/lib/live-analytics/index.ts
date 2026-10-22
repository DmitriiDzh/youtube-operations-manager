import { listLiveStreamEventsOfKind, listLiveViewerSamples } from "@/lib/db";
import { DAY_MS, type LiveSummary } from "./contracts";
import { summariseLive, type LiveEventInput, type LiveSampleInput } from "./summarise";

export * from "./contracts";
export { summariseLive, type LiveEventInput, type LiveSampleInput } from "./summarise";

// BL-213 (LIVE_ANALYTICS_PLAN.md stage 3): a channel's live-stream summary over the last N days, from what this computer
// stored -- the viewer samples (BL-211) and the encoder's run exits. Local only: never a YouTube call.
export type LiveAnalyticsDeps = {
  samples(channelId: string, from: Date, to: Date): Promise<LiveSampleInput[]>;
  runExits(channelId: string, from: Date): Promise<LiveEventInput[]>;
  now(): Date;
};

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
      return { range: { from: from.toISOString(), to: to.toISOString(), days }, ...summariseLive({ samples, events: inRange }) };
    },
  };
}
