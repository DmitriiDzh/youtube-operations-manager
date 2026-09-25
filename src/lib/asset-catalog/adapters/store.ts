import { randomUUID } from "node:crypto";
import { getCreativeAssetById, insertCreativeAsset, listCreativeAssetsByChannel } from "@/lib/db";

// Deliberately thin: only wraps the two db.ts functions this module needs, never touches
// channels/videos directly (channel-scoping is the caller's job -- see services.ts).
export function createAssetCatalogStoreAdapter() {
  return {
    idGenerator: (): string => randomUUID(),
    insertAsset: insertCreativeAsset,
    listAssetsByChannel: listCreativeAssetsByChannel,
    getAssetById: getCreativeAssetById,
  };
}

export type AssetCatalogStoreAdapter = ReturnType<typeof createAssetCatalogStoreAdapter>;
