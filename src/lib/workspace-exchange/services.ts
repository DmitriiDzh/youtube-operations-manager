import path from "node:path";
import { DATA_EXCHANGE_DIR_NAME, FROM_YTM_DIR_NAME, SENT_TO_YTM_DIR_NAME, type ExchangeReadFs, type ResolveFromYtmDirArgs } from "./contracts";

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

/**
 * BL-132 (FACTORY_MEDIA_CONTROL_PLAN.md §2.4): a job input file named by a path RELATIVE to
 * `<workspace>/99 Data Exchange/Sent to YTM/`. The relative path uses `/`, has no empty, `.` or `..` segment and is not
 * absolute; the folder and `99 Data Exchange` must be plain folders inside the workspace; the file's REAL path (symlinks
 * resolved) must lie inside the folder's real path, and be a regular file. Read-only: nothing is created or deleted.
 */
export async function resolveSentToYtmFile(args: Omit<ResolveFromYtmDirArgs, "fs"> & { fs: ExchangeReadFs; relativePath: string }): Promise<{ path: string; bytes: number }> {
  const relative = args.relativePath;
  const segments = relative.split("/");
  if (!relative || relative.length > 500 || relative.startsWith("/") || /^[A-Za-z]:/.test(relative) || relative.includes("\\") || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw args.unavailable(`"${relative}" is not a path relative to ${DATA_EXCHANGE_DIR_NAME}/${SENT_TO_YTM_DIR_NAME} (use / between folders, no .. or absolute paths)`);
  }
  const validation = await args.validateWorkspacePath(args.workspace);
  if (!validation.ok) throw args.unavailable(validation.reason);
  const realWorkspace = await args.fs.realpath(args.workspace).catch(() => null);
  if (!realWorkspace) throw args.unavailable("the workspace folder does not exist or is not accessible");
  const exchange = path.join(realWorkspace, DATA_EXCHANGE_DIR_NAME);
  const sent = path.join(exchange, SENT_TO_YTM_DIR_NAME);
  for (const folder of [exchange, sent]) {
    const info = await args.fs.lstat(folder);
    if (!info) throw args.unavailable(`${path.relative(realWorkspace, folder)} does not exist`);
    if (info.isSymbolicLink || !info.isDirectory) throw args.unavailable(`${path.relative(realWorkspace, folder)} is not a plain folder inside the workspace`);
  }
  const realSent = await args.fs.realpath(sent).catch(() => null);
  if (!realSent || !args.isPathInsideOrEqual(realWorkspace, realSent)) throw args.unavailable(`${DATA_EXCHANGE_DIR_NAME}/${SENT_TO_YTM_DIR_NAME} resolves outside the workspace`);
  const realFile = await args.fs.realpath(path.join(realSent, ...segments)).catch(() => null);
  if (!realFile) throw args.unavailable(`${relative} is not in ${DATA_EXCHANGE_DIR_NAME}/${SENT_TO_YTM_DIR_NAME}`);
  if (realFile === realSent || !args.isPathInsideOrEqual(realSent, realFile)) throw args.unavailable(`${relative} resolves outside ${DATA_EXCHANGE_DIR_NAME}/${SENT_TO_YTM_DIR_NAME}`);
  const info = await args.fs.stat(realFile);
  if (!info || !info.isFile) throw args.unavailable(`${relative} is not a regular file`);
  return { path: realFile, bytes: info.size };
}
