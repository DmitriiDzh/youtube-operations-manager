import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Immutable, timestamped backup of a channel's local Automerge document, captured immediately
 * before it is discarded and replaced (`services.ts`'s `discardLocalAndAdoptPeer`,
 * `docs/TECHNICAL_DEBT.md` RISK-46's "discard this device's diverged copy and re-adopt the other
 * side" resolution). Never overwrites -- each call gets its own unique filename (a UUID
 * suffix, not just a timestamp, so two discards in the same millisecond -- extremely unlikely,
 * but free to guard against -- never collide) -- matching `docs/PROJECT_SPEC.md` §16's
 * "no deletion is permanent and immediate" principle applied to this discard action.
 *
 * Deliberately its own tiny store rather than reusing `src/lib/backup/`: that module's
 * `BackupSnapshot` is shaped around one video's fields, keyed by `videoId` -- a whole-channel
 * Automerge document has no natural `videoId` to key on, so forcing this into that shape would
 * be a worse fit than a small, dedicated file store (see `platform-paths/contracts.ts`'s own
 * comment on `changeDraftsDiscardedBackupsDir` for the same reasoning `migrationBackupsDir`
 * already uses for its own whole-database backups).
 */
export type DiscardedDocumentBackupStore = {
  backup(channelId: string, bytes: Uint8Array): Promise<{ path: string; capturedAt: string }>;
};

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function createDiscardedDocumentBackupStore(baseDir: string): DiscardedDocumentBackupStore {
  return {
    async backup(channelId, bytes) {
      await mkdir(baseDir, { recursive: true });
      const capturedAt = new Date().toISOString();
      const fileName = `${sanitize(channelId)}--${capturedAt.replace(/[:.]/g, "-")}--${randomUUID()}.automerge`;
      const finalPath = path.join(baseDir, fileName);
      await writeFile(finalPath, bytes);
      return { path: finalPath, capturedAt };
    },
  };
}
