import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { createAssetCatalogStoreAdapter } from "./adapters/store";
import { createAssetCatalogServices } from "./services";

export function createAssetCatalogCore() {
  const store = createAssetCatalogStoreAdapter();
  // Reused unchanged from `changesets`' own channel/video store adapter (AGENTS.md §D) -- the
  // same local-sync mirror `ai-localization`/`agent-operations` already read.
  const channelStore = createChannelVideoStoreAdapter();

  return createAssetCatalogServices({
    idGenerator: store.idGenerator,
    insertAsset: store.insertAsset,
    listAssetsByChannel: store.listAssetsByChannel,
    getAssetById: store.getAssetById,
    async videoBelongsToChannel(channelId: string, videoId: string) {
      const videos = await channelStore.listVideosByChannel(channelId);
      return videos.some((video) => video.videoId === videoId);
    },
  });
}

export type AssetCatalogCore = ReturnType<typeof createAssetCatalogCore>;
export { ASSET_REFERENCE_KINDS, ASSET_TYPES } from "./contracts";
export type { AssetReferenceKind, AssetType, CreativeAsset } from "./contracts";
