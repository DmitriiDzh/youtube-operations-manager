import { createChangeSetChannelStoreAdapter } from "@/lib/changesets/adapters/store";
import { createAssetCatalogCore } from "@/lib/asset-catalog";
import { isDomainError as isAssetCatalogDomainError } from "@/lib/asset-catalog/contracts";
import { createContentProposalStoreAdapter } from "./adapters/store";
import { createContentProposalServices } from "./services";

export function createContentProposalCore() {
  const store = createContentProposalStoreAdapter();
  // Reused unchanged from `changesets`' own channel/video store adapter (AGENTS.md §D) -- the
  // same local-sync mirror `asset-catalog`/`ai-localization`/`agent-operations` already read.
  const channelStore = createChangeSetChannelStoreAdapter();
  // Reused unchanged from `asset-catalog`'s own channel-scoped `getAssetContext` (AGENTS.md §D)
  // -- never a second, parallel asset-ownership check.
  const assetCatalog = createAssetCatalogCore();

  return createContentProposalServices({
    idGenerator: store.idGenerator,
    insertProposal: store.insertProposal,
    listProposalsByChannel: store.listProposalsByChannel,
    getProposalById: store.getProposalById,
    async videoBelongsToChannel(channelId: string, videoId: string) {
      const videos = await channelStore.listVideosByChannel(channelId);
      return videos.some((video) => video.videoId === videoId);
    },
    async assetBelongsToChannel(channelId: string, assetId: string) {
      try {
        await assetCatalog.getAssetContext({ channelId, assetId });
        return true;
      } catch (error) {
        if (isAssetCatalogDomainError(error) && error.code === "ASSET_NOT_AVAILABLE") return false;
        throw error;
      }
    },
  });
}

export type ContentProposalCore = ReturnType<typeof createContentProposalCore>;
export type { ContentProposal, ContentProposalBrief } from "./contracts";
