import {
  deleteResearchChannel,
  getResearchChannelById,
  insertMarketChannelSnapshot,
  insertMarketVideoSnapshot,
  insertResearchChannel,
  insertResearchEvidence,
  listMarketChannelSnapshotsByChannel,
  listMarketVideoSnapshotsByChannel,
  listResearchChannels,
  listResearchEvidenceByChannel,
} from "@/lib/db";
import { createIdGenerator } from "../contracts";

// Deliberately thin: only wraps the db.ts functions this module needs (AGENTS.md §D -- one
// SQLite connection, `db.ts` owns all of it). Never touches channels/videos.
export function createMarketIntelligenceStoreAdapter() {
  return {
    idGenerator: createIdGenerator(),
    insertResearchChannel,
    listResearchChannels,
    getResearchChannelById,
    deleteResearchChannel,
    insertResearchEvidence,
    listResearchEvidenceByChannel,
    // Phase 9 slice 9A (docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md).
    insertMarketChannelSnapshot,
    listMarketChannelSnapshotsByChannel,
    insertMarketVideoSnapshot,
    listMarketVideoSnapshotsByChannel,
  };
}

export type MarketIntelligenceStoreAdapter = ReturnType<typeof createMarketIntelligenceStoreAdapter>;
