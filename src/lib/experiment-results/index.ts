import { MILESTONE_DAYS, createAnalyticsCore, hasFinalPublishDate, isMilestoneDue, milestoneWindow } from "@/lib/analytics";
import { createChannelSyncCore } from "@/lib/channel-sync";
import { createDecisionEngineCore } from "@/lib/decision-engine";
import { createReachReportsCore } from "@/lib/reach-reports";
import { DomainError } from "@/lib/shared-domain";
import { createExperimentResultsServices } from "./services";

// BL-170: the real wiring -- every read goes through its module's public, channel-scoped core (AGENTS.md §M).
export function createExperimentResultsCore() {
  const decisions = createDecisionEngineCore();
  const analytics = createAnalyticsCore();
  const channelSync = createChannelSyncCore();
  const reach = createReachReportsCore();
  return createExperimentResultsServices({
    getExperiment: (experimentId, ctx) => decisions.getExperiment(experimentId, ctx),
    listArms: (experimentId, ctx) => decisions.listExperimentArms(experimentId, ctx),
    async listVideos(channelId, credentialRef) {
      const result = (await channelSync.listSyncedVideos({ credentialRef, channelId })) as {
        videos: Array<{ videoId: string; title: string; publishedAt: string; privacyStatus: string; liveBroadcastContent?: string | null; durationSeconds?: number | null }>;
      };
      return result.videos.map((video) => ({
        videoId: video.videoId,
        title: video.title,
        publishedAt: video.publishedAt ?? null,
        privacyStatus: video.privacyStatus ?? null,
        liveBroadcastContent: video.liveBroadcastContent ?? null,
        durationSeconds: video.durationSeconds ?? null,
      }));
    },
    milestoneDays: MILESTONE_DAYS,
    windowOf: milestoneWindow,
    isDue: (windowEnd) => isMilestoneDue(windowEnd, new Date()),
    isPublished: (video) => hasFinalPublishDate({ videoId: "", ...video }),
    async listMilestones(channelId, videoIds, credentialRef) {
      const rows = [];
      for (let i = 0; i < videoIds.length; i += 50) {
        const { milestones } = await analytics.listVideoMilestones({ channelId, ...(credentialRef ? { credentialRef } : {}), videoIds: videoIds.slice(i, i + 50) });
        rows.push(...milestones);
      }
      return rows.map((row) => ({
        videoId: row.videoId,
        milestoneDays: row.milestoneDays,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
        status: row.status,
        collectedAt: row.collectedAt,
        totals: row.totals,
      }));
    },
    async listBreakdowns(channelId, videoId, startDate, endDate, credentialRef) {
      const result = await analytics.listStoredBreakdowns({ channelId, ...(credentialRef ? { credentialRef } : {}), videoIds: [videoId], startDate, endDate, groupBy: "day" });
      const video = result.videos?.[0];
      if (!video) return null;
      return {
        coverage: video.coverage ? { from: video.coverage.from, through: video.coverage.through } : null,
        trafficSources: video.trafficSources,
        devices: video.devices,
      };
    },
    async readReach(channelId, windows, credentialRef) {
      // Reach is read as the channel's signed-in user; without one the read reports `unauthorized` (as reachError).
      if (!credentialRef) throw new DomainError({ code: "unauthorized", message: "No signed-in user for the Reach read" });
      return reach.getVideoWindowsReach({ credentialRef, channelId, windows });
    },
  });
}

export type ExperimentResultsCore = ReturnType<typeof createExperimentResultsCore>;
export { getExperimentResultsInputSchema } from "./services";
export type { ExperimentResults } from "./services";
