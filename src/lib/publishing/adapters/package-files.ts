import { open, readdir } from "node:fs/promises";
import type { DirEntry } from "../package-scan";

/**
 * BL-182 stage 2: the scan's reads of the workspace. `readdir` with file types does not follow symlinks, so a symlinked folder
 * is "other" and the walk never leaves the workspace through one; every file is then reached through the workspace rule
 * (`resolveWorkspaceFile`), which proves its real path is inside. Read-only.
 */
export function createPackageFiles() {
  async function readUpTo(absolutePath: string, maxBytes: number): Promise<Buffer> {
    const handle = await open(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
  return {
    async listDir(absolutePath: string): Promise<DirEntry[]> {
      try {
        const entries = await readdir(absolutePath, { withFileTypes: true });
        return entries.map((entry) => ({ name: entry.name, kind: entry.isSymbolicLink() ? "other" : entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other" }));
      } catch {
        return [];
      }
    },
    /** The whole text, refused when the file is larger than `maxBytes` (a manifest is a few kilobytes). */
    async readText(absolutePath: string, maxBytes: number): Promise<string> {
      const bytes = await readUpTo(absolutePath, maxBytes + 1);
      if (bytes.length > maxBytes) throw new Error(`${absolutePath} is larger than ${maxBytes} bytes`);
      return bytes.toString("utf8");
    },
    async readHead(absolutePath: string, length: number): Promise<Uint8Array> {
      return new Uint8Array(await readUpTo(absolutePath, length));
    },
  };
}
