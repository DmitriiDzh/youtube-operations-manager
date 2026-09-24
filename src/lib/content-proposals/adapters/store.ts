import { randomUUID } from "node:crypto";
import {
  getContentProposalById,
  insertContentProposal,
  listContentProposalsByChannel,
  getContentProposalArtifactLinkById,
  insertContentProposalArtifactLink,
  listContentProposalArtifactLinksByProposal,
} from "@/lib/db";

// Deliberately thin: only wraps the db.ts functions this module needs, never touches
// channels/videos/assets directly (channel/video/asset-ownership scoping is the caller's job --
// see services.ts, which takes `videoBelongsToChannel`/`assetBelongsToChannel` as separate,
// injected dependencies).
export function createContentProposalStoreAdapter() {
  return {
    idGenerator: (): string => randomUUID(),
    insertProposal: insertContentProposal,
    listProposalsByChannel: listContentProposalsByChannel,
    getProposalById: getContentProposalById,
    insertArtifactLink: insertContentProposalArtifactLink,
    getArtifactLinkById: getContentProposalArtifactLinkById,
    listArtifactLinksByProposal: listContentProposalArtifactLinksByProposal,
  };
}

export type ContentProposalStoreAdapter = ReturnType<typeof createContentProposalStoreAdapter>;
