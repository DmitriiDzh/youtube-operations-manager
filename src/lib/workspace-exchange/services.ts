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
export async function resolveSentToYtmFile(
  args: Omit<ResolveFromYtmDirArgs, "fs"> & { fs: ExchangeReadFs; relativePath: string }
): Promise<{ path: string; bytes: number; identity?: { dev: number; ino: number } }> {
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
  // The identity lets the uploader prove it reads THIS file, not one swapped in after the check (independent review).
  return { path: realFile, bytes: info.size, ...(info.dev !== undefined && info.ino !== undefined ? { identity: { dev: info.dev, ino: info.ino } } : {}) };
}

/**
 * BL-143 (ADR 0029): a job output the owner listens to -- a file the media module wrote under
 * `<workspace>/99 Data Exchange/From YTM/<subdir>/<jobId>/`. The given path (the job's recorded `localPath`) must, after
 * symlink resolution, lie inside that job folder's real path and be a regular file; `99 Data Exchange` and `From YTM` must be
 * plain folders inside the workspace. Read-only: nothing is created.
 */
export async function resolveFromYtmJobFile(
  args: Omit<ResolveFromYtmDirArgs, "fs"> & { fs: ExchangeReadFs; subdir: string; jobId: string; filePath: string }
): Promise<{ path: string; bytes: number }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(args.jobId) || !/^[A-Za-z0-9_-]{1,64}$/.test(args.subdir)) throw args.unavailable("not a job folder");
  const validation = await args.validateWorkspacePath(args.workspace);
  if (!validation.ok) throw args.unavailable(validation.reason);
  const realWorkspace = await args.fs.realpath(args.workspace).catch(() => null);
  if (!realWorkspace) throw args.unavailable("the workspace folder does not exist or is not accessible");
  const exchange = path.join(realWorkspace, DATA_EXCHANGE_DIR_NAME);
  const from = path.join(exchange, FROM_YTM_DIR_NAME);
  for (const folder of [exchange, from]) {
    const info = await args.fs.lstat(folder);
    if (!info) throw args.unavailable(`${path.relative(realWorkspace, folder)} does not exist`);
    if (info.isSymbolicLink || !info.isDirectory) throw args.unavailable(`${path.relative(realWorkspace, folder)} is not a plain folder inside the workspace`);
  }
  // The subfolder and the job folder must be plain folders too (review B4): a symlinked one could point anywhere in the workspace.
  for (const folder of [path.join(from, args.subdir), path.join(from, args.subdir, args.jobId)]) {
    const info = await args.fs.lstat(folder);
    if (!info) throw args.unavailable("the job's output folder is not in the workspace on this device");
    if (info.isSymbolicLink || !info.isDirectory) throw args.unavailable(`${path.relative(realWorkspace, folder)} is not a plain folder inside the workspace`);
  }
  const realFrom = await args.fs.realpath(from).catch(() => null);
  const realJobDir = await args.fs.realpath(path.join(from, args.subdir, args.jobId)).catch(() => null);
  if (!realFrom || !realJobDir || !args.isPathInsideOrEqual(realWorkspace, realFrom) || realJobDir === realFrom || !args.isPathInsideOrEqual(realFrom, realJobDir)) {
    throw args.unavailable("the job's output folder is not in the workspace on this device");
  }
  const realFile = await args.fs.realpath(args.filePath).catch(() => null);
  if (!realFile) throw args.unavailable("the file is not on this device");
  if (realFile === realJobDir || !args.isPathInsideOrEqual(realJobDir, realFile)) throw args.unavailable("the file is outside the job's output folder");
  const info = await args.fs.stat(realFile);
  if (!info || !info.isFile) throw args.unavailable("not a regular file");
  return { path: realFile, bytes: info.size };
}
