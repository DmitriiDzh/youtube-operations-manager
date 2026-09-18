import { DomainError, isDomainError, type BackupHealth, type BackupRecord, type BackupSnapshot } from "./contracts";

type BackupStoreDeps = {
  healthCheck(): Promise<BackupHealth>;
  write(args: {
    channelId: string;
    batchId: string;
    videoId: string;
    snapshot: BackupSnapshot;
  }): Promise<{ path: string }>;
};

type ServiceDependencies = {
  store: BackupStoreDeps;
  clock: () => Date;
};

function mapUnknownError(error: unknown): string {
  if (isDomainError(error)) return error.message;
  return error instanceof Error ? error.message : "Unknown backup error";
}

export function createBackupServices(deps: ServiceDependencies) {
  /**
   * AC-BACKUP-04: checked ONCE per batch, before any per-video work -- a systemic
   * infrastructure failure (connectivity/permissions to the whole backup store) halts
   * the entire batch, distinct from a single video's backup failing while the store
   * itself is healthy (see captureBackup below / AC-BACKUP-02).
   */
  async function checkInfrastructureHealth(): Promise<BackupHealth> {
    return deps.store.healthCheck();
  }

  /**
   * AC-BACKUP-01: must be called, and must succeed, before any write attempt for this
   * video. AC-BACKUP-02: a failure here is item-level (this video's write is blocked;
   * the rest of the batch is unaffected) -- callers must not treat this as systemic
   * (that classification is checkInfrastructureHealth's job, checked earlier, once).
   * AC-BACKUP-03: never overwrites -- enforced by the store adapter, not here.
   */
  async function captureBackup(args: {
    channelId: string;
    batchId: string;
    videoId: string;
    snapshot: BackupSnapshot;
  }): Promise<BackupRecord> {
    try {
      const result = await deps.store.write(args);
      return { path: result.path, capturedAt: deps.clock().toISOString() };
    } catch (error) {
      throw new DomainError({
        code: "backup_item_failed",
        message: `Backup failed for video ${args.videoId}: ${mapUnknownError(error)}`,
        details: { videoId: args.videoId },
      });
    }
  }

  return { checkInfrastructureHealth, captureBackup };
}

export type BackupServices = ReturnType<typeof createBackupServices>;
