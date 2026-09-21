import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Pure byte-level persistence for one channel's Automerge document -- deliberately knows nothing
 * about Automerge itself (no `@automerge/automerge` import here). `services.ts` is what
 * interprets the bytes this adapter loads/saves via `Automerge.load`/`Automerge.save`, following
 * `docs/DEVELOPMENT_PLAYBOOK.md` §6.2: an adapter wraps I/O, business/domain logic does not live
 * here. This keeps the adapter trivially fakeable in tests (an in-memory `Map`, no real
 * filesystem) without needing to fake Automerge's own behavior too.
 */
export type ChangeDraftsStoreAdapter = {
  loadDocumentBytes(channelId: string): Promise<Uint8Array | null>;
  saveDocumentBytes(channelId: string, bytes: Uint8Array): Promise<void>;
};

function documentPath(baseDir: string, channelId: string): string {
  // channelId is a real YouTube channel id (UC...), never user-supplied free text reaching a
  // filesystem path -- still sanitized defensively in case that assumption is ever violated by a
  // future caller.
  const safeName = channelId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(baseDir, `${safeName}.automerge`);
}

/**
 * Real filesystem-backed adapter, rooted at `baseDir` (production callers pass
 * `getProductionAppPaths().changeDraftsDir`, `src/lib/platform-paths/runtime.ts` -- test-isolated
 * automatically the same way `src/lib/db.ts`/`src/lib/backup/` already are).
 */
export function createFilesystemChangeDraftsStore(baseDir: string): ChangeDraftsStoreAdapter {
  return {
    async loadDocumentBytes(channelId: string): Promise<Uint8Array | null> {
      try {
        const buffer = await readFile(documentPath(baseDir, channelId));
        return new Uint8Array(buffer);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    async saveDocumentBytes(channelId: string, bytes: Uint8Array): Promise<void> {
      await mkdir(baseDir, { recursive: true });
      await writeFile(documentPath(baseDir, channelId), bytes);
    },
  };
}
