import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPathInsideOrEqual } from "@/lib/local-path-validation";
import type { VideoCostFile } from "../contracts";

const NAME = /^V[1-9][0-9]{0,5}_cost\.json$/;
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * BL-194 stage 3: `Vn_cost.json` in a video's folder of the channel workspace. The folder must exist and really be inside the
 * workspace (symlinks resolved); the file is written whole or not at all (a temporary file in the same folder, then a rename).
 */
export function createCostFiles(workspaceOf: (channelId: string) => Promise<string>) {
  async function locate(channelId: string, relativePath: string): Promise<string> {
    const slash = relativePath.lastIndexOf("/");
    const name = relativePath.slice(slash + 1);
    if (slash <= 0 || !NAME.test(name)) throw new Error(`Not a cost file name: ${name}`);
    const workspace = await realpath(await workspaceOf(channelId));
    const folder = await realpath(path.join(workspace, ...relativePath.slice(0, slash).split("/")));
    if (folder === workspace || !isPathInsideOrEqual(workspace, folder)) throw new Error("The video folder is outside the channel workspace.");
    return path.join(folder, name);
  }
  return {
    async read(channelId: string, relativePath: string): Promise<unknown | null> {
      let target: string;
      try {
        target = await locate(channelId, relativePath);
      } catch {
        return null;
      }
      try {
        const text = await readFile(target, "utf8");
        if (text.length > MAX_BYTES) return null;
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    },
    async write(channelId: string, relativePath: string, document: VideoCostFile): Promise<void> {
      const target = await locate(channelId, relativePath);
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, target);
    },
  };
}
