import { promises as fs } from "node:fs";
import type { PathValidationDependencies } from "../services";

/** Thin `node:fs/promises` wrappers for `validateWorkspacePath` -- metadata only (`realpath`/
 * `stat`), never a directory listing or a file read. */
export function createPathValidationFsAdapter(): Pick<PathValidationDependencies, "realpath" | "stat"> {
  return {
    async realpath(path) {
      return fs.realpath(path);
    },
    async stat(path) {
      const s = await fs.stat(path);
      return { isDirectory: s.isDirectory() };
    },
  };
}
