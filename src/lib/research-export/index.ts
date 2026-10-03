import { randomBytes, randomUUID } from "node:crypto";
import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { rawSqlClient } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { createMarketAssignmentCore } from "@/lib/market-assignments";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import { createNodeExportFs } from "./adapters/fs";
import { createResearchExportLedger } from "./adapters/ledger";
import { createResearchExportServices } from "./services";

/**
 * Research export (ADR 0019). Reads only through the existing public cores -- market-intelligence's `getWatchlistEntryContext` (which already
 * applies the 30-day policy window) and market-assignments' agent confinement (the same `filterForAgent`/`assertAvailableToAgent` the
 * `query_competitors`/`query_market_intelligence` tools use) -- so an export can never show more than those tools do.
 */
export function createResearchExportCore() {
  const marketIntelligence = createMarketIntelligenceCore();
  const marketAssignments = createMarketAssignmentCore();
  const workspaces = createChannelWorkspacesCore();
  const videoStore = createChannelVideoStoreAdapter();

  return createResearchExportServices({
    now: () => new Date(),
    randomSuffix: () => randomBytes(2).toString("hex"),
    newId: () => randomUUID(),
    async getWorkspacePath(channelId) {
      const result = await workspaces.getWorkspace({ channelId });
      return result.configured ? result.path : null;
    },
    validateWorkspacePath: validateOperatorDirectoryPath,
    isPathInsideOrEqual,
    async listWatchlistChannelIds() {
      const { channels } = await marketIntelligence.listWatchlist();
      return (await marketAssignments.filterForAgent("research_channel", channels, (c) => c.channelId)).map((c) => c.channelId);
    },
    async getWatchlistContext(researchChannelId) {
      await marketAssignments.assertAvailableToAgent("research_channel", researchChannelId);
      const context = await marketIntelligence.getWatchlistEntryContext({ channelId: researchChannelId });
      return {
        channel: { channelId: context.channel.channelId, handleOrUrl: context.channel.handleOrUrl },
        evidenceCount: context.evidence.length,
        channelSnapshots: context.channelSnapshots,
        videoSnapshots: context.videoSnapshots,
        dataQualityFlags: context.dataQualityFlags,
      };
    },
    async getOwnChannel(channelId) {
      const channel = await videoStore.getChannel(channelId);
      return channel ? { channelId: channel.channelId, title: channel.title } : null;
    },
    async listOwnVideos(channelId) {
      return (await videoStore.listVideosByChannel(channelId)).map((video) => ({
        videoId: video.videoId,
        publishedAt: video.publishedAt,
        privacyStatus: video.privacyStatus,
        title: video.title,
        viewCount: video.viewCount,
        likeCount: video.likeCount,
        commentCount: video.commentCount,
        lastSyncedAt: video.lastSyncedAt,
      }));
    },
    fs: createNodeExportFs(),
    ledger: createResearchExportLedger(),
  });
}

/** Scheduled sweep (`src/instrumentation.ts`): deletes the expired export files this module wrote. Skips quietly while the device may not mutate
 * (operation lock / recovery mode), like the 30-day data purge; the next run tries again. */
export async function sweepExpiredResearchExports(now: Date = new Date()) {
  try {
    await assertDeviceAvailableForMutation(rawSqlClient);
  } catch {
    return null;
  }
  return createResearchExportCore().sweepExpiredExports(now);
}

export type ResearchExportCore = ReturnType<typeof createResearchExportCore>;
export { exportResearchDataInputSchema, listResearchOverviewInputSchema } from "./schemas";
export { isDomainError } from "./contracts";
export type { ExportResearchDataResult } from "./contracts";
