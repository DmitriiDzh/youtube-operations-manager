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
 * -- injected rather than the whole core, so a fake in tests only has to implement three methods. */
export type ChangeDraftsForSync = {
  exportBytes(input: { channelId: string }): Promise<Uint8Array>;
  mergeIncoming(input: { channelId: string; incomingBytes: Uint8Array }): Promise<{ newConflicts: FieldConflict[] }>;
  discardLocalAndAdoptPeer(input: { channelId: string; incomingBytes: Uint8Array }): Promise<{ backupPath: string | null }>;
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
    let pushError: string | null = null;
    try {
      const bytes = await deps.changeDrafts.exportBytes({ channelId });
      await deps.transport.writeDeviceFile(root, channelId, deviceId, bytes);
      pushed = true;
    } catch (error) {
      // A channel this device has never created any drafts for yet has no document to export
      // (`change-drafts/services.ts`'s `exportBytes` throws `not_found` rather than manufacture
      // one, AC-CRDT semantics) -- nothing to push this cycle, not a failure, no error to report.
      if (isDomainError(error) && error.code === "not_found") {
        pushError = null;
      } else {
        // A REAL push failure -- e.g. the configured Syncthing folder is an unmounted external
        // drive, a permissions error, disk full. Found via advisor review after this module's
        // own live verification used exactly such a folder: previously this rethrew, aborting
        // the entire cycle (including every OTHER channel) with no operator-visible signal
        // beyond a bare 500 every polling interval. Isolate it to this one channel instead,
        // exactly like a bad peer file is isolated below -- the pull/merge side is unrelated to
        // whether the push succeeded, so it still proceeds.
        pushError = error instanceof Error ? error.message : "unknown error";
        deps.logger.error({ event: "change_drafts_sync.push_failed", context: { channelId, reason: pushError } });
      }
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

    return { channelId, pushed, pushError, peersMerged, peersSkipped, newConflicts };
  }

  /** Shared by `runCycle` and `adoptDivergentPeer` -- both need the same resolved root and the
   * same device identity, and must apply the identical `checkRootAvailable` guard before
   * touching anything under a configured (as opposed to local-fallback) Syncthing root. */
  async function resolveConfigAndRoot(): Promise<{ deviceId: string; syncthingRootPath: string | null; root: string }> {
    const config = await deps.bootstrapConfig.ensureExists();
    const root = config.syncthingRootPath
      ? path.join(config.syncthingRootPath, "change-drafts")
      : deps.localFallbackDir;
    return { deviceId: config.deviceId, syncthingRootPath: config.syncthingRootPath, root };
  }

  async function runCycle(): Promise<SyncCycleResult> {
    const startedAt = new Date().toISOString();
    const config = await resolveConfigAndRoot();
    const root = config.root;

    const channelIds = await deps.listChannelIds();

    // Checked ONCE per cycle, against the RAW configured value -- never against the local
    // fallback, which is always a safe path under this app's own app-data directory. See
    // `filesystem-transport.ts`'s `checkRootAvailable` doc comment for the macOS
    // phantom-mount-point risk this guards against. A missing root makes every channel this
    // cycle unreachable for both push AND pull (there is nothing behind it to read either), so
    // this degrades the whole cycle rather than attempting per-channel work that would just fail
    // the same way for every channel.
    let rootUnavailableReason: string | null = null;
    if (config.syncthingRootPath) {
      try {
        await deps.transport.checkRootAvailable(config.syncthingRootPath);
      } catch (error) {
        rootUnavailableReason = error instanceof Error ? error.message : "unknown error";
        deps.logger.error({
          event: "change_drafts_sync.sync_root_unavailable",
          context: { root: config.syncthingRootPath, reason: rootUnavailableReason },
        });
      }
    }

    const channels: ChannelSyncResult[] = [];
    for (const channelId of channelIds) {
      channels.push(
        rootUnavailableReason
          ? { channelId, pushed: false, pushError: rootUnavailableReason, peersMerged: [], peersSkipped: [], newConflicts: [] }
          : await syncOneChannel(channelId, config.deviceId, root)
      );
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

  /**
   * RISK-46 (docs/TECHNICAL_DEBT.md): the explicit, operator-triggered "discard my local copy,
   * adopt this peer's version instead" resolution for a channel whose document diverged from a
   * specific peer's (`divergent_document_lineage`, surfaced in `peersSkipped`). Re-reads the
   * peer's CURRENT file from the sync folder rather than trusting any bytes cached from an
   * earlier cycle -- the file, or the whole sync root, may no longer be reachable by the time the
   * operator acts on it, so this applies the identical `checkRootAvailable` guard `runCycle` uses
   * before touching a configured Syncthing root.
   */
  async function adoptDivergentPeerNow(input: { channelId: string; peerDeviceId: string }): Promise<{ backupPath: string | null }> {
    const config = await resolveConfigAndRoot();
    if (config.syncthingRootPath) {
      await deps.transport.checkRootAvailable(config.syncthingRootPath);
    }

    const peerFiles = await deps.transport.listPeerFiles(config.root, input.channelId, config.deviceId);
    const peer = peerFiles.find((p) => p.deviceId === input.peerDeviceId);
    if (!peer) {
      throw new Error(
        `Peer device "${input.peerDeviceId}" has no file for channel ${input.channelId} in the sync folder -- it may have already resynced, or the file is temporarily unavailable`
      );
    }

    return deps.changeDrafts.discardLocalAndAdoptPeer({ channelId: input.channelId, incomingBytes: peer.bytes });
  }

  // Single-flight guard (advisor-reviewed requirement): multiple overlapping triggers (several
  // open browser tabs each polling on their own timer, plus an explicit "Sync now" click) must
  // never run two sync cycles concurrently against the same local documents/files -- a caller
  // arriving while a cycle is already running gets that SAME cycle's eventual result rather than
  // starting a second, racing one. `adoptDivergentPeer` shares this exclusion (via
  // `syncInFlight`/`adoptInFlight` each waiting on the OTHER's in-flight promise before starting)
  // rather than coalescing with it -- they are different operations, so a caller of one while the
  // other is running gets its OWN result once the other finishes, not the other's result.
  let syncInFlight: Promise<SyncCycleResult> | null = null;
  let adoptInFlight: Promise<{ backupPath: string | null }> | null = null;

  return {
    async runSyncCycle(): Promise<SyncCycleResult> {
      if (syncInFlight) return syncInFlight;
      if (adoptInFlight) await adoptInFlight.catch(() => {});
      const cycle = runCycle().finally(() => {
        if (syncInFlight === cycle) syncInFlight = null;
      });
      syncInFlight = cycle;
      return cycle;
    },

    async adoptDivergentPeer(input: { channelId: string; peerDeviceId: string }): Promise<{ backupPath: string | null }> {
      // Unlike `runSyncCycle` (parameterless -- coalescing concurrent callers into the same
      // result is correct there), this takes `{channelId, peerDeviceId}`: two different calls
      // that happened to overlap (e.g. adopting peer B for one channel, then peer C for another,
      // in quick succession) must never have the second one silently receive the first one's
      // result. Reject outright instead -- advisor review caught that the original coalescing
      // form would report the wrong peer's backup path/success to the caller.
      if (adoptInFlight) {
        throw new Error("Another divergent-lineage adoption is already in progress -- try again shortly");
      }
      if (syncInFlight) await syncInFlight.catch(() => {});
      const op = adoptDivergentPeerNow(input).finally(() => {
        if (adoptInFlight === op) adoptInFlight = null;
      });
      adoptInFlight = op;
      return op;
    },
  };
}

export type ChangeDraftsSyncCore = ReturnType<typeof createChangeDraftsSyncCore>;
