import { getCreativeAssetById, insertCreativeAsset, listCreativeAssetsByChannel } from "@/lib/db";
import { createIdGenerator } from "../contracts";

// Deliberately thin: only wraps the two db.ts functions this module needs, never touches
// channels/videos directly (channel-scoping is the caller's job -- see services.ts).
export function createAssetCatalogStoreAdapter() {
  return {
    idGenerator: createIdGenerator(),
    insertAsset: insertCreativeAsset,
    listAssetsByChannel: listCreativeAssetsByChannel,
    getAssetById: getCreativeAssetById,
  };
}

export type AssetCatalogStoreAdapter = ReturnType<typeof createAssetCatalogStoreAdapter>;
