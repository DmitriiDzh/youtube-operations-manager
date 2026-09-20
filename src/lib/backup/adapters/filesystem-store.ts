import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BackupHealth, BackupSnapshot } from "../contracts";
import { getProductionAppPaths } from "@/lib/platform-paths";

/**
 * Layout: <root>/<channelId>/<operationId>/<videoId>.metadata_before.json -- scoped by
 * operationId (a Batch id, or a single-video edit's own id -- see contracts.ts's comment on
 * `BackupSnapshot`) so a later, unrelated write touching the same video never collides with an
 * earlier one's backup path (AC-BACKUP-03). `wx` is the write flag that fails atomically
 * (EEXIST) if the file already exists -- this is what actually enforces "never overwritten" at
 * the filesystem level, not merely a pre-check that could race with a concurrent writer.
 *
 * `root` defaults to the platform-aware app-data location's backups directory
 * (docs/decisions/0002-additive-schema-versioning.md's companion task, "Pre-Release
 * Cross-Platform Persistence" -- replaces the previous `<cwd>/data/backups` default; tests
 * inject an explicit isolated temp path, unchanged).
 */
export function createFilesystemBackupStore(root: string = getProductionAppPaths().backupsDir) {
  return {
    async healthCheck(): Promise<BackupHealth> {
      try {
        await mkdir(root, { recursive: true });
        return { healthy: true };
      } catch (error) {
        return {
          healthy: false,
          error: error instanceof Error ? error.message : "Backup storage is unreachable",
        };
      }
    },

    async write(args: {
      channelId: string;
      operationId: string;
      videoId: string;
      snapshot: BackupSnapshot;
    }): Promise<{ path: string }> {
      const dir = path.join(root, args.channelId, args.operationId);
      await mkdir(dir, { recursive: true });

      const filePath = path.join(dir, `${args.videoId}.metadata_before.json`);
      // Serializes whichever snapshot variant was passed wholesale (its `kind` discriminator
      // is preserved in the output) -- no more hardcoding the localization-specific field
      // names, now that a second, structurally different variant exists (contracts.ts).
      const content = JSON.stringify(
        {
          videoId: args.videoId,
          operationId: args.operationId,
          channelId: args.channelId,
          capturedAt: new Date().toISOString(),
          snapshot: args.snapshot,
        },
        null,
        2
      );

      await writeFile(filePath, content, { flag: "wx" });
      return { path: filePath };
    },
  };
}
