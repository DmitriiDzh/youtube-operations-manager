import { randomUUID } from "node:crypto";
import { link, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPathInsideOrEqual } from "@/lib/local-path-validation";

/**
 * A `Vn_youtube.json` next to a release, inside the channel workspace (its real folder checked), written whole or not at all.
 * Shared since BL-221: the upload runner writes it after an upload (it may replace its own earlier record), and the owner's
 * «Привязать к видео» writes it for a video uploaded outside the app (`exclusive`: never over an existing record).
 */
export async function writeUploadRecordFile(
  workspacePath: string,
  relativePath: string,
  record: unknown,
  options: { exclusive?: boolean } = {},
): Promise<void> {
  const slash = relativePath.lastIndexOf("/");
  const name = relativePath.slice(slash + 1);
  if (!/^V\d+_youtube\.json$/.test(name)) throw new Error(`Not an upload record name: ${name}`);
  const workspace = await realpath(workspacePath);
  const folder = slash < 0 ? workspace : await realpath(path.join(workspace, ...relativePath.slice(0, slash).split("/")));
  if (folder === workspace || !isPathInsideOrEqual(workspace, folder)) throw new Error("The package folder is outside the channel workspace.");
  const target = path.join(folder, name);
  const temporary = path.join(folder, `.${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    // `exclusive`: a hard link fails with EEXIST when the record is there -- atomic, unlike a check before `rename`.
    if (options.exclusive) await link(temporary, target);
    else await rename(temporary, target);
  } catch (error) {
    if (!options.exclusive) await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    if (options.exclusive) await unlink(temporary).catch(() => undefined);
  }
}
