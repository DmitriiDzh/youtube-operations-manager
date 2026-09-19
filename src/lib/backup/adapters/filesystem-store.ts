import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BackupHealth, BackupSnapshot } from "../contracts";
import { getProductionAppPaths } from "@/lib/platform-paths";

/**
 * Layout: <root>/<channelId>/<batchId>/<videoId>.metadata_before.json -- scoped by
 * batchId so a later batch touching the same video never collides with an earlier one's
 * backup path (AC-BACKUP-03). `wx` is the write flag that fails atomically (EEXIST) if
 * the file already exists -- this is what actually enforces "never overwritten" at the
 * filesystem level, not merely a pre-check that could race with a concurrent writer.
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
      batchId: string;
      videoId: string;
      snapshot: BackupSnapshot;
    }): Promise<{ path: string }> {
      const dir = path.join(root, args.channelId, args.batchId);
      await mkdir(dir, { recursive: true });

      const filePath = path.join(dir, `${args.videoId}.metadata_before.json`);
      const content = JSON.stringify(
        {
          videoId: args.videoId,
          batchId: args.batchId,
          channelId: args.channelId,
          capturedAt: new Date().toISOString(),
          defaultLanguage: args.snapshot.defaultLanguage,
          existingLocalizations: args.snapshot.existingLocalizations,
        },
        null,
        2
      );

      await writeFile(filePath, content, { flag: "wx" });
      return { path: filePath };
    },
  };
}
