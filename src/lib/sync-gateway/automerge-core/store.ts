import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Pure byte-level persistence for one Automerge document, keyed by an opaque string (a
 * channelId for a per-channel document family, or a constant like `"global"` for a
 * single-document family). Generic across every document shape this sync gateway catalogs --
 * mirrors `change-drafts/adapters/automerge-store.ts`'s own shape exactly (that module predates
 * this generic extraction and is left as-is, `AGENTS.md` §D, rather than risk touching
 * already-shipped CD1-CD7 code for a rename).
 */
export type DocumentByteStore = {
  loadDocumentBytes(key: string): Promise<Uint8Array | null>;
  saveDocumentBytes(key: string, bytes: Uint8Array): Promise<void>;
};

function documentPath(baseDir: string, key: string): string {
  const safeName = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(baseDir, `${safeName}.automerge`);
}

/** Real filesystem-backed adapter, rooted at `baseDir`. */
export function createFilesystemDocumentStore(baseDir: string): DocumentByteStore {
  return {
    async loadDocumentBytes(key: string): Promise<Uint8Array | null> {
      try {
        const buffer = await readFile(documentPath(baseDir, key));
        return new Uint8Array(buffer);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    async saveDocumentBytes(key: string, bytes: Uint8Array): Promise<void> {
      await mkdir(baseDir, { recursive: true });
      // Same atomic temp-file+rename discipline as change-drafts' own store -- a crash mid-write
      // must never leave a truncated, unloadable document.
      const finalPath = documentPath(baseDir, key);
      const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
      await writeFile(tmpPath, bytes);
      await rename(tmpPath, finalPath);
    },
  };
}

/**
 * Immutable, timestamped backup of a document captured immediately before it is discarded and
 * replaced (the divergent-lineage "discard mine, adopt peer's" resolution, mirrors
 * `change-drafts/adapters/discarded-backup-store.ts`). Never overwrites.
 */
export type DiscardedDocumentBackupStore = {
  backup(key: string, bytes: Uint8Array): Promise<{ path: string; capturedAt: string }>;
};

export function createDiscardedDocumentBackupStore(baseDir: string): DiscardedDocumentBackupStore {
  return {
    async backup(key, bytes) {
      await mkdir(baseDir, { recursive: true });
      const capturedAt = new Date().toISOString();
      const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
      const fileName = `${safeKey}--${capturedAt.replace(/[:.]/g, "-")}--${randomUUID()}.automerge`;
      const finalPath = path.join(baseDir, fileName);
      await writeFile(finalPath, bytes);
      return { path: finalPath, capturedAt };
    },
  };
}
