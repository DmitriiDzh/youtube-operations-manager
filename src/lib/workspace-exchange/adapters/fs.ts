import { lstat, mkdir, realpath } from "node:fs/promises";
import type { ExchangeFs } from "../contracts";

export function createExchangeFs(): ExchangeFs {
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
  };
}
