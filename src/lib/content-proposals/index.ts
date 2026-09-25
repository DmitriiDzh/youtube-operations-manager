import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { createAssetCatalogCore } from "@/lib/asset-catalog";
import { createContentProposalStoreAdapter } from "./adapters/store";
import { isDomainError } from "./contracts";
import { createContentProposalServices } from "./services";

export function createContentProposalCore() {
  const store = createContentProposalStoreAdapter();
  // Reused unchanged from `changesets`' own channel/video store adapter (AGENTS.md §D) -- the
  // same local-sync mirror `asset-catalog`/`ai-localization`/`agent-operations` already read.
  const channelStore = createChannelVideoStoreAdapter();
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
        if (isDomainError(error) && error.code === "ASSET_NOT_AVAILABLE") return false;
        throw error;
      }
    },
    // Phase 7 slice G2 -- delegates unchanged to `asset-catalog`'s own `registerAsset`
    // (AGENTS.md §D): this module never inserts into `creative_assets` itself.
    registerAsset: assetCatalog.registerAsset,
    insertArtifactLink: store.insertArtifactLink,
    getArtifactLinkById: store.getArtifactLinkById,
    listArtifactLinksByProposal: store.listArtifactLinksByProposal,
    async getAssetById(channelId: string, assetId: string) {
      try {
        return await assetCatalog.getAssetContext({ channelId, assetId });
      } catch (error) {
        if (isDomainError(error) && error.code === "ASSET_NOT_AVAILABLE") return null;
        throw error;
      }
    },
  });
}

export type ContentProposalCore = ReturnType<typeof createContentProposalCore>;
export type { ContentProposal, ContentProposalBrief, ProposalArtifactLink } from "./contracts";
export { AGENT_ARTIFACT_REFERENCE_KINDS } from "./schemas";
