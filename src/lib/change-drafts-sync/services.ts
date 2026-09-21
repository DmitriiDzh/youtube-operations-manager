import path from "node:path";
import { isDomainError, type ChannelSyncResult, type FieldConflict, type SyncCycleResult } from "./contracts";
import type { ChangeDraftsSyncTransportAdapter } from "./adapters/filesystem-transport";

export type ChangeDraftsSyncLogger = {
  info(payload: { event: string; context?: Record<string, unknown> }): void;
  error(payload: { event: string; context?: Record<string, unknown> }): void;
};

export type BootstrapConfigLike = {
  ensureExists(): Promise<{ deviceId: string; syncthingRootPath: string | null }>;
};

/** The narrow slice of `ChangeDraftsCore` (`src/lib/change-drafts/`) this module actually needs
 * -- injected rather than the whole core, so a fake in tests only has to implement two methods. */
export type ChangeDraftsForSync = {
  exportBytes(input: { channelId: string }): Promise<Uint8Array>;
  mergeIncoming(input: { channelId: string; incomingBytes: Uint8Array }): Promise<{ newConflicts: FieldConflict[] }>;
};

export type ServiceDependencies = {
  bootstrapConfig: BootstrapConfigLike;
  /** Local-only directory used when the operator has not configured a Syncthing-shared folder
   * yet -- mirrors `resolveSnapshotsDir`'s identical fallback (`src/app/api/device-handoff/shared.ts`). */
  localFallbackDir: string;
  listChannelIds(): Promise<string[]>;
  changeDrafts: ChangeDraftsForSync;
  transport: ChangeDraftsSyncTransportAdapter;
  logger: ChangeDraftsSyncLogger;
};

export function createChangeDraftsSyncCore(deps: ServiceDependencies) {
  async function syncOneChannel(channelId: string, deviceId: string, root: string): Promise<ChannelSyncResult> {
    let pushed = false;
    try {
      const bytes = await deps.changeDrafts.exportBytes({ channelId });
      await deps.transport.writeDeviceFile(root, channelId, deviceId, bytes);
      pushed = true;
    } catch (error) {
      // A channel this device has never created any drafts for yet has no document to export
      // (`change-drafts/services.ts`'s `exportBytes` throws `not_found` rather than manufacture
      // one, AC-CRDT semantics) -- nothing to push this cycle, not a failure. Any other error is
      // real and must propagate.
      if (!(isDomainError(error) && error.code === "not_found")) throw error;
    }

    const peerFiles = await deps.transport.listPeerFiles(root, channelId, deviceId);
    const peersMerged: string[] = [];
    const peersSkipped: Array<{ deviceId: string; reason: string }> = [];
    let newConflicts: FieldConflict[] = [];

    for (const peer of peerFiles) {
      try {
        const result = await deps.changeDrafts.mergeIncoming({ channelId, incomingBytes: peer.bytes });
        peersMerged.push(peer.deviceId);
        newConflicts = newConflicts.concat(result.newConflicts);
      } catch (error) {
        // Isolate one bad peer file (corrupted mid-write bytes that failed `Automerge.load`, or a
        // genuinely divergent-lineage device, `divergent_document_lineage`) from the rest of the
        // cycle -- the same reasoning as `change-drafts/services.ts`'s own projection-isolation:
        // one peer's problem must never abort syncing every OTHER peer or channel this cycle, but
        // it must never be silently swallowed either.
        const reason = isDomainError(error) ? error.code : error instanceof Error ? error.message : "unknown error";
        peersSkipped.push({ deviceId: peer.deviceId, reason });
        deps.logger.error({
          event: "change_drafts_sync.peer_merge_failed",
          context: { channelId, peerDeviceId: peer.deviceId, reason },
        });
      }
    }

    return { channelId, pushed, peersMerged, peersSkipped, newConflicts };
  }

  async function runCycle(): Promise<SyncCycleResult> {
    const startedAt = new Date().toISOString();
    const config = await deps.bootstrapConfig.ensureExists();
    const root = config.syncthingRootPath
      ? path.join(config.syncthingRootPath, "change-drafts")
      : deps.localFallbackDir;

    const channelIds = await deps.listChannelIds();
    const channels: ChannelSyncResult[] = [];
    for (const channelId of channelIds) {
      channels.push(await syncOneChannel(channelId, config.deviceId, root));
    }

    deps.logger.info({
      event: "change_drafts_sync.cycle_complete",
      context: {
        deviceId: config.deviceId,
        channelCount: channels.length,
        totalNewConflicts: channels.reduce((sum, c) => sum + c.newConflicts.length, 0),
      },
    });

    return {
      deviceId: config.deviceId,
      syncRoot: root,
      startedAt,
      finishedAt: new Date().toISOString(),
      channels,
      totalNewConflicts: channels.reduce((sum, c) => sum + c.newConflicts.length, 0),
    };
  }

  // Single-flight guard (advisor-reviewed requirement): multiple overlapping triggers (several
  // open browser tabs each polling on their own timer, plus an explicit "Sync now" click) must
  // never run two sync cycles concurrently against the same local documents/files -- a caller
  // arriving while a cycle is already running gets that SAME cycle's eventual result rather than
  // starting a second, racing one.
  let inFlight: Promise<SyncCycleResult> | null = null;

  return {
    async runSyncCycle(): Promise<SyncCycleResult> {
      if (inFlight) return inFlight;
      const cycle = runCycle().finally(() => {
        if (inFlight === cycle) inFlight = null;
      });
      inFlight = cycle;
      return cycle;
    },
  };
}

export type ChangeDraftsSyncCore = ReturnType<typeof createChangeDraftsSyncCore>;
