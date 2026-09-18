import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BackupHealth, BackupSnapshot } from "../contracts";

const DEFAULT_BACKUPS_ROOT = path.join(process.cwd(), "data", "backups");

/**
 * Layout: <root>/<channelId>/<batchId>/<videoId>.metadata_before.json -- scoped by
 * batchId so a later batch touching the same video never collides with an earlier one's
 * backup path (AC-BACKUP-03). `wx` is the write flag that fails atomically (EEXIST) if
 * the file already exists -- this is what actually enforces "never overwritten" at the
 * filesystem level, not merely a pre-check that could race with a concurrent writer.
 */
export function createFilesystemBackupStore(root: string = DEFAULT_BACKUPS_ROOT) {
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
