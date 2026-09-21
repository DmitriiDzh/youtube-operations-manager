import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";
import type { FieldConflict } from "@/lib/change-drafts/contracts";

export type { DomainErrorCode, DomainErrorShape, FieldConflict };
export { DomainError, isDomainError };

/**
 * The outcome of syncing one channel's Automerge document during a single sync cycle
 * (AUTOMERGE_MIGRATION_PLAN.md §6 CD5). `peersSkipped` exists so a corrupted/mid-write peer file
 * or a device with no shared history (`divergent_document_lineage`,
 * `src/lib/change-drafts/services.ts`) never silently disappears from view -- it is isolated
 * from the rest of the cycle (never aborts syncing other peers/channels), but still surfaced,
 * never swallowed.
 */
export type ChannelSyncResult = {
  channelId: string;
  pushed: boolean;
  peersMerged: string[];
  peersSkipped: Array<{ deviceId: string; reason: string }>;
  newConflicts: FieldConflict[];
};

export type SyncCycleResult = {
  deviceId: string;
  syncRoot: string;
  startedAt: string;
  finishedAt: string;
  channels: ChannelSyncResult[];
  totalNewConflicts: number;
};
