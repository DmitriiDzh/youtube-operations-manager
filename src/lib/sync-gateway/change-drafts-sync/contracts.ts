import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";
import type { FieldConflict } from "../change-drafts/contracts";

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
  /** Set only when a push was actually attempted (a local document exists) and failed for a
   * real reason -- e.g. the configured Syncthing folder is an unmounted external drive. `null`
   * both when the push succeeded and when there was legitimately nothing to push
   * (no local document for this channel yet). Never thrown -- a push failure isolates to this
   * one channel, exactly like `peersSkipped` isolates one bad peer file. */
  pushError: string | null;
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
