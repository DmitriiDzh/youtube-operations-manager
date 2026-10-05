import path from "node:path";
import { DATA_EXCHANGE_DIR_NAME, FROM_YTM_DIR_NAME, SENT_TO_YTM_DIR_NAME, type ResolveFromYtmDirArgs } from "./contracts";

/**
 * Folder = `<realpath(workspace)>/99 Data Exchange/From YTM`, created if missing and proven (after
 * symlink resolution) to still lie strictly inside the workspace. The sibling `Sent to YTM` folder is
 * created empty alongside. A symlink or a non-folder at any of the three paths is refused; a folder
 * that cannot be created is refused with the cause. Never writes a file itself.
 */
export async function resolveFromYtmDir(args: ResolveFromYtmDirArgs): Promise<string> {
  const validation = await args.validateWorkspacePath(args.workspace);
  if (!validation.ok) throw args.unavailable(validation.reason);

  const realWorkspace = await args.fs.realpath(args.workspace).catch(() => null);
  if (!realWorkspace) throw args.unavailable("path does not exist or is not accessible");
  const exchange = path.join(realWorkspace, DATA_EXCHANGE_DIR_NAME);
  const dir = path.join(exchange, FROM_YTM_DIR_NAME);
  for (const folder of [exchange, dir, path.join(exchange, SENT_TO_YTM_DIR_NAME)]) {
    const label = path.relative(realWorkspace, folder);
    const existing = await args.fs.lstat(folder);
    if (existing && (existing.isSymbolicLink || !existing.isDirectory)) throw args.unavailable(`${label} is not a plain folder inside the workspace`);
    if (!existing) {
      try {
        await args.fs.mkdir(folder);
      } catch (error) {
        throw args.unavailable(`${label} could not be created (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }
  const realDir = await args.fs.realpath(dir).catch(() => null);
  if (!realDir || realDir === realWorkspace || !args.isPathInsideOrEqual(realWorkspace, realDir)) {
    throw args.unavailable(`${DATA_EXCHANGE_DIR_NAME}/${FROM_YTM_DIR_NAME} resolves outside the workspace`);
  }
  return realDir;
}
