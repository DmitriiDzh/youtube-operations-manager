import { createAssetCatalogCore } from "@/lib/asset-catalog";
import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { createAnalyticsCore } from "@/lib/analytics";
import { createAssetPerformanceServices } from "./services";
import { isDomainError } from "./contracts";

export function createAssetPerformanceCore() {
  // Reused unchanged (AGENTS.md §D) -- the same asset catalog, channel/video store adapter, and
  // analytics core every other Phase 7 capability already reads. No new store, no new YouTube
  // call, no parallel age-alignment implementation (`getCumulativeValueAtDayOffset` is imported
  // directly by `services.ts`, shared with slice K, not reimplemented here).
  const assetCatalogCore = createAssetCatalogCore();
  const channelStore = createChannelVideoStoreAdapter();
  const analyticsCore = createAnalyticsCore();

  return createAssetPerformanceServices({
    listAssetsByChannel: assetCatalogCore.listAssets,
    listVideosByChannel: channelStore.listVideosByChannel,
    listMetrics: analyticsCore.listMetrics,
  });
}

export type AssetPerformanceCore = ReturnType<typeof createAssetPerformanceCore>;
export type {
  AssetPerformanceEntry,
  AssetPerformanceLinkedVideo,
  AssetPerformanceSortMode,
  ListAssetPerformanceInput,
  ListAssetPerformanceResult,
} from "./contracts";
export { ASSET_PERFORMANCE_SORT_MODES } from "./contracts";
export { isDomainError };
