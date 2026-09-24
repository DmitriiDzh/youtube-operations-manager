import { randomUUID } from "node:crypto";
import { getContentProposalById, insertContentProposal, listContentProposalsByChannel } from "@/lib/db";

// Deliberately thin: only wraps the three db.ts functions this module needs, never touches
// channels/videos/assets directly (channel/video/asset-ownership scoping is the caller's job --
// see services.ts, which takes `videoBelongsToChannel`/`assetBelongsToChannel` as separate,
// injected dependencies).
export function createContentProposalStoreAdapter() {
  return {
    idGenerator: (): string => randomUUID(),
    insertProposal: insertContentProposal,
    listProposalsByChannel: listContentProposalsByChannel,
    getProposalById: getContentProposalById,
  };
}

export type ContentProposalStoreAdapter = ReturnType<typeof createContentProposalStoreAdapter>;
