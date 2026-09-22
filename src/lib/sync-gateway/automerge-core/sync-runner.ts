import path from "node:path";
import type { PerChannelTransportAdapter } from "./transport";

export type SyncRunnerLogger = {
  info(payload: { event: string; context?: Record<string, unknown> }): void;
  error(payload: { event: string; context?: Record<string, unknown> }): void;
};

export type BootstrapConfigLike = {
  ensureExists(): Promise<{ deviceId: string; syncthingRootPath: string | null }>;
};

export type ChannelSyncResult = {
  channelId: string;
  pushed: boolean;
  pushError: string | null;
  peersMerged: string[];
  peersSkipped: Array<{ deviceId: string; reason: string }>;
  newConflictsCount: number;
};

export type SyncCycleResult = {
  deviceId: string;
  syncRoot: string;
  startedAt: string;
  finishedAt: string;
  channels: ChannelSyncResult[];
  totalNewConflicts: number;
};

/** The narrow slice of a document family's core this runner needs. */
export type DocumentFamilyForSync = {
  exportBytes(channelId: string): Promise<Uint8Array>;
  /** Throws a DomainError with code "not_found" when there is nothing local to push yet. */
  mergeIncoming(channelId: string, incomingBytes: Uint8Array): Promise<{ newConflictsCount: number }>;
};

export type SyncRunnerDeps = {
  /** Distinguishes this family's own subfolder under a configured Syncthing root, and its own
   * local-fallback directory when none is configured -- so two families' exchange files never
   * mix (e.g. "editorial-profile" vs change-drafts-sync's own "change-drafts"). */
  syncthingSubfolderName: string;
  bootstrapConfig: BootstrapConfigLike;
  localFallbackDir: string;
  listChannelIds(): Promise<string[]>;
  family: DocumentFamilyForSync;
  transport: PerChannelTransportAdapter;
  logger: SyncRunnerLogger;
  isNotFoundError(error: unknown): boolean;
  describeError(error: unknown): string;
};

/**
 * Generic per-channel sync-cycle runner -- the same push/pull/isolate-errors/single-flight shape
 * `change-drafts-sync/services.ts` already proved for the draft layer (CD5), generalized so a
 * second per-channel document family (editorial-profile) doesn't need its own copy-pasted
 * reimplementation. `change-drafts-sync/` itself is left untouched (`AGENTS.md` §D) -- it keeps
 * running its own cycle for change_sets/changes exactly as before; this runner powers a
 * SEPARATE, independent cycle for other families, deliberately isolated (one family's sync bug
 * never blocks another's, matching `AGENTS.md` §M's module-independence philosophy).
 */
export function createSyncRunner(deps: SyncRunnerDeps) {
  async function resolveConfigAndRoot(): Promise<{ deviceId: string; syncthingRootPath: string | null; root: string }> {
    const config = await deps.bootstrapConfig.ensureExists();
    const root = config.syncthingRootPath
      ? path.join(config.syncthingRootPath, deps.syncthingSubfolderName)
      : deps.localFallbackDir;
    return { deviceId: config.deviceId, syncthingRootPath: config.syncthingRootPath, root };
  }

  async function syncOneChannel(channelId: string, deviceId: string, root: string): Promise<ChannelSyncResult> {
    let pushed = false;
    let pushError: string | null = null;
    try {
      const bytes = await deps.family.exportBytes(channelId);
      await deps.transport.writeDeviceFile(root, channelId, deviceId, bytes);
      pushed = true;
    } catch (error) {
      if (deps.isNotFoundError(error)) {
        pushError = null;
      } else {
        pushError = deps.describeError(error);
        deps.logger.error({ event: "sync_runner.push_failed", context: { channelId, reason: pushError } });
      }
    }

    const peerFiles = await deps.transport.listPeerFiles(root, channelId, deviceId);
    const peersMerged: string[] = [];
    const peersSkipped: Array<{ deviceId: string; reason: string }> = [];
    let newConflictsCount = 0;

    for (const peer of peerFiles) {
      try {
        const result = await deps.family.mergeIncoming(channelId, peer.bytes);
        peersMerged.push(peer.deviceId);
        newConflictsCount += result.newConflictsCount;
      } catch (error) {
        const reason = deps.describeError(error);
        peersSkipped.push({ deviceId: peer.deviceId, reason });
        deps.logger.error({ event: "sync_runner.peer_merge_failed", context: { channelId, peerDeviceId: peer.deviceId, reason } });
      }
    }

    return { channelId, pushed, pushError, peersMerged, peersSkipped, newConflictsCount };
  }

  async function runCycle(): Promise<SyncCycleResult> {
    const startedAt = new Date().toISOString();
    const config = await resolveConfigAndRoot();
    const channelIds = await deps.listChannelIds();

    let rootUnavailableReason: string | null = null;
    if (config.syncthingRootPath) {
      try {
        await deps.transport.checkRootAvailable(config.syncthingRootPath);
      } catch (error) {
        rootUnavailableReason = deps.describeError(error);
        deps.logger.error({ event: "sync_runner.sync_root_unavailable", context: { root: config.syncthingRootPath, reason: rootUnavailableReason } });
      }
    }

    const channels: ChannelSyncResult[] = [];
    for (const channelId of channelIds) {
      channels.push(
        rootUnavailableReason
          ? { channelId, pushed: false, pushError: rootUnavailableReason, peersMerged: [], peersSkipped: [], newConflictsCount: 0 }
          : await syncOneChannel(channelId, config.deviceId, config.root)
      );
    }

    const totalNewConflicts = channels.reduce((sum, c) => sum + c.newConflictsCount, 0);
    deps.logger.info({
      event: "sync_runner.cycle_complete",
      context: { deviceId: config.deviceId, family: deps.syncthingSubfolderName, channelCount: channels.length, totalNewConflicts },
    });

    return { deviceId: config.deviceId, syncRoot: config.root, startedAt, finishedAt: new Date().toISOString(), channels, totalNewConflicts };
  }

  // Single-flight guard -- same reasoning as change-drafts-sync/services.ts's own runSyncCycle:
  // several overlapping triggers must never run two cycles concurrently against the same files.
  let cycleInFlight: Promise<SyncCycleResult> | null = null;

  return {
    async runSyncCycle(): Promise<SyncCycleResult> {
      if (cycleInFlight) return cycleInFlight;
      const cycle = runCycle().finally(() => {
        if (cycleInFlight === cycle) cycleInFlight = null;
      });
      cycleInFlight = cycle;
      return cycle;
    },
  };
}

export type SyncRunner = ReturnType<typeof createSyncRunner>;
