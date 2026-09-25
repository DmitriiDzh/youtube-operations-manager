import type { AssetPerformanceEntry, ListAssetPerformanceResult } from "./contracts";
import type { AssetReferenceKind, AssetType } from "@/lib/asset-catalog";
import {
  listAssetPerformanceInputSchema,
  listAssetPerformanceOutputSchema,
  parseWithSchema,
  DEFAULT_ASSET_PERFORMANCE_LIMIT,
  MAX_ASSET_PERFORMANCE_LIMIT,
} from "./schemas";
import { getCumulativeValueAtDayOffset } from "@/lib/analytics/comparable-age";

export type AssetForPerformanceJoin = {
  assetId: string;
  assetType: AssetType;
  title: string | null;
  referenceKind: AssetReferenceKind;
  referenceValue: string;
  linkedVideoId: string | null;
};

export type VideoForPerformanceJoin = {
  videoId: string;
  channelId: string;
  title: string;
  publishedAt: string;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  durationSeconds: number | null;
  lastSyncedAt: Date;
};

export type ServiceDependencies = {
  /** Forwards straight into `assetCatalogCore.listAssets` unchanged (AGENTS.md §D) -- no second,
   * parallel asset-read path. */
  listAssetsByChannel(input: { channelId: string; assetType?: string }): Promise<{ assets: AssetForPerformanceJoin[] }>;
  /** Forwards straight into the same channel/video store adapter `comparable-content`/
   * `ai-localization`/`changesets` already read (AGENTS.md §D) -- no second, parallel video-read
   * path. Returns every video for the WHOLE channel (needed to resolve `linkedVideoId` against),
   * not scoped to any one asset. */
  listVideosByChannel(channelId: string): Promise<VideoForPerformanceJoin[]>;
  /** Forwards straight into `analyticsCore.listMetrics` unchanged (AGENTS.md §D) -- only ever
   * called when `performanceMetric`/`performanceDayOffset` are actually requested. */
  listMetrics(input: {
    credentialRef: unknown;
    channelId: string;
    metricNames: string[];
  }): Promise<{ channelId: string; rows: Array<{ videoId: string; metricDate: string; metricName: string; metricValue: number }> }>;
};

export function createAssetPerformanceServices(deps: ServiceDependencies) {
  return {
    /**
     * Owner spec §16's asset-performance linkage. Local reads only -- never a live YouTube call.
     * Not itself channel-scope-checked (mirrors slice K's own convention: the MCP/CLI caller
     * checks `channelAccessCore.assertActiveChannel` before this is ever invoked). A JOIN, not a
     * FILTER -- see `docs/acceptance/PHASE_7_ACCEPTANCE.md` §5's own scope statement.
     */
    async listAssetPerformance(input: unknown): Promise<ListAssetPerformanceResult> {
      const parsedInput = parseWithSchema(listAssetPerformanceInputSchema, input, "list asset performance input");

      const [{ assets: allAssets }, allVideos] = await Promise.all([
        deps.listAssetsByChannel({ channelId: parsedInput.channelId, assetType: parsedInput.assetType }),
        deps.listVideosByChannel(parsedInput.channelId),
      ]);
      const videosById = new Map(allVideos.map((video) => [video.videoId, video]));

      let metricRowsByVideoId: Map<string, Array<{ metricDate: string; metricValue: number }>> | null = null;
      if (parsedInput.performanceMetric) {
        const metricsResult = await deps.listMetrics({
          credentialRef: parsedInput.credentialRef,
          channelId: parsedInput.channelId,
          metricNames: [parsedInput.performanceMetric],
        });
        metricRowsByVideoId = new Map();
        for (const row of metricsResult.rows) {
          if (row.metricName !== parsedInput.performanceMetric) continue;
          const existing = metricRowsByVideoId.get(row.videoId) ?? [];
          existing.push({ metricDate: row.metricDate, metricValue: row.metricValue });
          metricRowsByVideoId.set(row.videoId, existing);
        }
      }

      let excludedUnlinked = 0;
      let excludedLinkedVideoNotOnChannel = 0;

      const entries: AssetPerformanceEntry[] = [];
      for (const asset of allAssets) {
        if (!asset.linkedVideoId) {
          excludedUnlinked += 1;
          continue;
        }

        // `videosById` is built from `deps.listVideosByChannel(parsedInput.channelId)`, which is
        // itself already channel-scoped (the real dependency, `listStoredVideosByChannel`, filters
        // by channelId at the SQL layer) -- so "not found" and "found but on a different channel"
        // are structurally indistinguishable from here, and asset registration itself already
        // validates linkedVideoId against the same channel at write time (`asset-catalog`'s own
        // `registerAsset`). The explicit `channelId` re-check below is defense-in-depth (AGENTS.md
        // §F: channel-context validation is never automatic, never assumed from a dependency's own
        // behavior), not a second, more specific failure mode -- both paths are counted the same.
        const video = videosById.get(asset.linkedVideoId);
        if (!video || video.channelId !== parsedInput.channelId) {
          excludedLinkedVideoNotOnChannel += 1;
          continue;
        }

        let ageAlignedPerformanceValue: number | null = null;
        if (parsedInput.performanceMetric && parsedInput.performanceDayOffset !== undefined) {
          const rows = metricRowsByVideoId?.get(video.videoId) ?? [];
          ageAlignedPerformanceValue = getCumulativeValueAtDayOffset({
            publishedAt: video.publishedAt,
            metricRows: rows,
            dayOffset: parsedInput.performanceDayOffset,
          });
        }

        entries.push({
          assetId: asset.assetId,
          assetType: asset.assetType,
          title: asset.title,
          referenceKind: asset.referenceKind,
          referenceValue: asset.referenceValue,
          linkedVideo: {
            videoId: video.videoId,
            title: video.title,
            publishedAt: video.publishedAt,
            lifetimeViewCount: video.viewCount,
            lifetimeLikeCount: video.likeCount,
            lifetimeCommentCount: video.commentCount,
            durationSeconds: video.durationSeconds,
            lifetimeCountersAsOf: video.lastSyncedAt.toISOString(),
            ageAlignedPerformanceValue,
          },
        });
      }

      const sort = parsedInput.sort ?? "linkedVideoPublicationDate";
      entries.sort((a, b) => {
        switch (sort) {
          case "linkedVideoPublicationDate":
            return b.linkedVideo.publishedAt.localeCompare(a.linkedVideo.publishedAt);
          case "lifetimeViewCount": {
            const aVal = a.linkedVideo.lifetimeViewCount ?? -1;
            const bVal = b.linkedVideo.lifetimeViewCount ?? -1;
            return bVal - aVal;
          }
          case "performanceMetric": {
            const aVal = a.linkedVideo.ageAlignedPerformanceValue ?? -Infinity;
            const bVal = b.linkedVideo.ageAlignedPerformanceValue ?? -Infinity;
            return bVal - aVal;
          }
          default:
            return 0;
        }
      });

      const requestedLimit = parsedInput.limit ?? DEFAULT_ASSET_PERFORMANCE_LIMIT;
      const limit = Math.min(requestedLimit, MAX_ASSET_PERFORMANCE_LIMIT);
      const truncated = entries.length > limit;
      const limited = entries.slice(0, limit);

      return parseWithSchema(
        listAssetPerformanceOutputSchema,
        {
          assets: limited,
          performanceAlignment:
            parsedInput.performanceMetric && parsedInput.performanceDayOffset !== undefined
              ? { metricName: parsedInput.performanceMetric, dayOffset: parsedInput.performanceDayOffset }
              : null,
          excludedForMissingLink: {
            unlinked: excludedUnlinked,
            linkedVideoNotOnChannel: excludedLinkedVideoNotOnChannel,
          },
          truncated,
        },
        "list asset performance output"
      );
    },
  };
}

export type AssetPerformanceServices = ReturnType<typeof createAssetPerformanceServices>;
