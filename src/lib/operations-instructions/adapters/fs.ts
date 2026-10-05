import { promises as fs } from "node:fs";

/**
 * Thin, direct wrappers over `node:fs/promises` -- no business logic here (path-traversal
 * prevention, symlink-escape checks, extension allowlisting all live in `services.ts`, where they
 * can be unit-tested against real temporary directories, per `docs/DEVELOPMENT_PLAYBOOK.md` §6.2's
 * "adapters do I/O, services do orchestration" split).
 */
export type FsAdapter = {
  /** Resolves symlinks; throws if the path doesn't exist. */
  realpath(path: string): Promise<string>;
  /** Directory entry names only -- callers `lstat` each one themselves to classify it. */
  readdir(path: string): Promise<string[]>;
  /** Does NOT follow a symlink -- used to detect a symlink *entry* before deciding whether to
   * follow it via `realpath`. */
  lstat(path: string): Promise<{ isDirectory: boolean; isSymbolicLink: boolean; isFile: boolean }>;
  /** Follows symlinks (like a normal open()) -- used only after containment is already verified
   * via `realpath`. */
  stat(path: string): Promise<{ isDirectory: boolean; isFile: boolean; sizeBytes: number }>;
  /** Reads at most `maxBytes + 1` bytes so the caller can detect truncation without re-reading. */
  readFileHead(path: string, maxBytes: number): Promise<{ content: string; truncated: boolean }>;
};

export function createFsAdapter(): FsAdapter {
  return {
    async realpath(path) {
      return fs.realpath(path);
    },
    async readdir(path) {
      return fs.readdir(path);
    },
    async lstat(path) {
      const s = await fs.lstat(path);
      return { isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink(), isFile: s.isFile() };
    },
    async stat(path) {
      const s = await fs.stat(path);
      return { isDirectory: s.isDirectory(), isFile: s.isFile(), sizeBytes: s.size };
    },
    async readFileHead(path, maxBytes) {
      const handle = await fs.open(path, "r");
      try {
        const buffer = Buffer.alloc(maxBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const truncated = bytesRead > maxBytes;
        return { content: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"), truncated };
      } finally {
        await handle.close();
      }
    },
  };
}
