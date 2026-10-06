import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import type { ExchangeReadFs } from "../contracts";

export function createExchangeFs(): ExchangeReadFs {
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
    stat: async (p) => {
      try {
        const info = await stat(p);
        return { isFile: info.isFile(), size: info.size };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}
