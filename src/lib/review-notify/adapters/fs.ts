import { randomBytes } from "node:crypto";
import { lstat, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "@/lib/rename-retry";
import { PRODUCER_FOLDER_NAME, PRODUCER_INBOX_NAME, type InboxWriteOutcome } from "../contracts";

// BL-248 (REVIEW_NOTIFY_PLAN.md §5, §8): the Inbox on disk. A file is written once: never over an existing one, first under a dot
// name (`wait_inbox.sh` ignores dotfiles) in the same folder, then renamed -- the Producer never sees a partial file (AC-RN-09).

/** The file operations the writer uses (injectable: a test records every name the folder ever sees). */
export type InboxFsOps = {
  writeFile(file: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Whether anything (a file, a folder, a link) has this name. */
  exists(file: string): Promise<boolean>;
  unlink(file: string): Promise<void>;
};

export const nodeInboxFsOps: InboxFsOps = {
  // `wx`: a temporary name that somehow exists is never written through.
  writeFile: (file, content) => writeFile(file, content, { encoding: "utf8", flag: "wx" }),
  rename: (from, to) => renameWithRetry(from, to, rename),
  exists: (file) => lstat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  ),
  unlink: (file) => unlink(file),
};

export function createInboxWriter(ops: InboxFsOps = nodeInboxFsOps, randomPart: () => string = () => randomBytes(8).toString("hex")) {
  return async function writeOnce(dir: string, name: string, content: string): Promise<InboxWriteOutcome> {
    if (name.startsWith(".") || name.includes("/") || name.includes("\\")) throw new Error(`not a plain file name: ${name}`);
    const finalPath = path.join(dir, name);
    if (await ops.exists(finalPath)) return "exists";
    const tmp = path.join(dir, `.tmp-${randomPart()}`);
    try {
      await ops.writeFile(tmp, content);
      // Checked again right before the rename: the file must never be replaced (§5).
      if (await ops.exists(finalPath)) {
        await ops.unlink(tmp).catch(() => undefined);
        return "exists";
      }
      await ops.rename(tmp, finalPath);
      return "written";
    } catch (error) {
      await ops.unlink(tmp).catch(() => undefined);
      throw error;
    }
  };
}

export async function isDirectory(absolutePath: string): Promise<boolean> {
  try {
    return (await stat(absolutePath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The workspace root (REVIEW_NOTIFY_PLAN.md §8): the one parent folder of every channel workspace set on this computer; null when
 * none is set or they have different parents (the owner then sets the Inbox folder himself).
 */
export function workspaceRootOf(channelWorkspaces: readonly string[]): string | null {
  const parents = [...new Set(channelWorkspaces.filter((p) => path.isAbsolute(p)).map((p) => path.dirname(path.resolve(p))))];
  return parents.length === 1 ? parents[0] : null;
}

export const producerFolderOf = (root: string) => path.join(root, PRODUCER_FOLDER_NAME);
export const defaultInboxOf = (root: string) => path.join(root, PRODUCER_FOLDER_NAME, PRODUCER_INBOX_NAME);

