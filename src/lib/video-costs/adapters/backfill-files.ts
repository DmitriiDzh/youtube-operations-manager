import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveWorkspaceFile } from "@/lib/workspace-exchange";
import { createWorkspaceVideoFiles, isVideoFileName, listVideoFolders } from "@/lib/workspace-videos";

/**
 * BL-194 stage 4: the channel workspace's `MMDD Vn` folders with the size of each video file, and the sha256 of one workspace file
 * (reached through the workspace rule: its real path inside the workspace, a regular file). Read-only. A hash is kept for the life
 * of the process per path, size and modification time, so listing the proposals twice does not read a video twice.
 */
export function createBackfillFiles(workspaceOf: (channelId: string) => Promise<string>) {
  const files = createWorkspaceVideoFiles();
  const hashes = new Map<string, string>();
  return {
    async videoFolders(channelId: string): Promise<Array<{ video: string; folder: string; files: Array<{ name: string; bytes: number }> }>> {
      const workspace = await workspaceOf(channelId);
      const valid = await validateOperatorDirectoryPath(workspace);
      if (!valid.ok) throw new Error(valid.reason);
      const folders = await listVideoFolders({ listDir: (p) => files.listDir(p), join: (...parts) => path.join(...parts) }, workspace);
      const out = [];
      for (const folder of folders) {
        const sized: Array<{ name: string; bytes: number }> = [];
        for (const name of folder.files.filter(isVideoFileName)) {
          const info = await stat(path.join(workspace, ...folder.folder.split("/"), name)).catch(() => null);
          if (info?.isFile()) sized.push({ name, bytes: info.size });
        }
        out.push({ video: folder.video, folder: folder.folder, files: sized });
      }
      return out;
    },
    async hashOf(channelId: string, relativePath: string): Promise<string> {
      const file = await resolveWorkspaceFile({
        workspace: await workspaceOf(channelId),
        relativePath,
        fs: createExchangeFs(),
        validateWorkspacePath: validateOperatorDirectoryPath,
        isPathInsideOrEqual,
        unavailable: (reason) => new Error(reason),
      });
      const info = await stat(file.path);
      const key = `${file.path}:${info.size}:${info.mtimeMs}`;
      const known = hashes.get(key);
      if (known) return known;
      const hash = createHash("sha256");
      await new Promise<void>((resolve, reject) => {
        createReadStream(file.path)
          .on("data", (chunk) => hash.update(chunk))
          .on("end", () => resolve())
          .on("error", reject);
      });
      const digest = hash.digest("hex");
      hashes.set(key, digest);
      return digest;
    },
  };
}
