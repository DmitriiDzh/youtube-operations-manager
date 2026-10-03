import { lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import type { ResearchExportDeps } from "../services";

export function createNodeExportFs(): ResearchExportDeps["fs"] {
  return {
    realpath: (p) => realpath(p),
    mkdir: async (p) => {
      await mkdir(p);
    },
    lstat: async (p) => {
      try {
        const info = await lstat(p);
        return { isDirectory: info.isDirectory(), isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink() };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    writeNewFile: (p, data) => writeFile(p, data, { encoding: "utf8", flag: "wx", mode: 0o644 }),
    rename: (from, to) => rename(from, to),
    unlink: (p) => unlink(p),
  };
}
