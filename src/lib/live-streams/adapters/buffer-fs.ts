import { copyFile, mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import type { BufferFs } from "../buffer";

// BL-176 (LIVE_STREAMS_PLAN.md §3.5): the buffer's file operations on this computer's disk.
export function createBufferFs(): BufferFs {
  return {
    mkdirp: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    list: async (dir) => readdir(dir).catch(() => []),
    copy: (from, to) => copyFile(from, to),
    rename: (from, to) => rename(from, to),
    remove: (file) => rm(file, { force: true }),
    size: async (file) => (await stat(file).catch(() => null))?.size ?? null,
    freeBytes: async (dir) => {
      const info = await statfs(dir);
      return Number(info.bavail) * Number(info.bsize);
    },
  };
}
