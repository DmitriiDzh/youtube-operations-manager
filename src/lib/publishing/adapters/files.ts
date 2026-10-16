import { randomUUID } from "node:crypto";
import { realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPathInsideOrEqual } from "@/lib/local-path-validation";
import { VIDEOS_FOLDER } from "@/lib/workspace-videos";

// The shared workspace rule (`workspace-exchange`): a path relative to the channel workspace, proven inside it after symlinks.
export { createExchangeFs as createWorkspaceExchangeFsForPublishing, resolveWorkspaceFile as resolveWorkspaceFileForPublishing } from "@/lib/workspace-exchange";

/**
 * BL-192: writes `<workspace>/<folder>/<name>` whole or not at all (a temporary file, then a rename), only when the folder's real path
 * is strictly inside the workspace's real `04 Videos/` (a symlinked folder pointing elsewhere is refused). Overwrites an existing file.
 */
export async function writeVideoFolderFile(workspace: string, folder: string, name: string, text: string): Promise<void> {
  if (name.includes("/") || name.includes("\\") || name.startsWith(".")) throw new Error(`Not a file name: ${name}`);
  const root = await realpath(workspace);
  const videosRoot = await realpath(path.join(root, VIDEOS_FOLDER));
  const target = await realpath(path.join(root, ...folder.split("/")));
  if (target === videosRoot || !isPathInsideOrEqual(videosRoot, target)) throw new Error("The video folder is outside the channel's 04 Videos.");
  const temporary = path.join(target, `.${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path.join(target, name));
}
