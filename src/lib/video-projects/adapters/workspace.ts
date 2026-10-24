import path from "node:path";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveWorkspaceFile } from "@/lib/workspace-exchange";
import {
  createWorkspaceVideoFiles,
  listVideoFolders,
  parseUploadRecord,
  parseVideoRegistry,
  uploadRecordFileName,
  VIDEO_REGISTRY_FILE,
  VIDEOS_FOLDER,
  type VideoRegistryRow,
} from "@/lib/workspace-videos";
import type { UploadRecordLink, WorkspaceVideos } from "../contracts";

/** The registry is a few kilobytes per hundred rows. */
const REGISTRY_MAX_BYTES = 4 * 1024 * 1024;
/** A `Vn_youtube.json` is a few hundred bytes. */
const UPLOAD_RECORD_MAX_BYTES = 64 * 1024;

/**
 * BL-194: the channel workspace's `MMDD Vn` folders (an empty one included) and `04 Videos/video_registry.csv`, read through the
 * shared `workspace-videos` rules (never through a symlink; the registry reached through the workspace rule). Read-only.
 */
export function createVideoProjectsWorkspace(workspaceOf: (channelId: string) => Promise<{ configured: false } | { configured: true; path: string }>) {
  const files = createWorkspaceVideoFiles();
  return async (channelId: string): Promise<WorkspaceVideos> => {
    const workspace = await workspaceOf(channelId);
    if (!workspace.configured) return { status: "not_configured" };
    const valid = await validateOperatorDirectoryPath(workspace.path);
    if (!valid.ok) return { status: "unavailable", reason: valid.reason };
    const folders = await listVideoFolders({ listDir: (p) => files.listDir(p), join: (...parts) => path.join(...parts) }, workspace.path);
    const resolve = (relativePath: string) =>
      resolveWorkspaceFile({
        workspace: workspace.path,
        relativePath,
        fs: createExchangeFs(),
        validateWorkspacePath: validateOperatorDirectoryPath,
        isPathInsideOrEqual,
        unavailable: (reason) => new Error(reason),
      });
    let registry: VideoRegistryRow[] = [];
    try {
      const file = await resolve(`${VIDEOS_FOLDER}/${VIDEO_REGISTRY_FILE}`);
      registry = parseVideoRegistry(await files.readText(file.path, REGISTRY_MAX_BYTES));
    } catch {
      registry = []; // no registry (or an unreadable one) is not an error: the factory may not keep one
    }
    // BL-221: the video each folder's `Vn_youtube.json` names; an unreadable record is skipped, never an error.
    const uploadRecords: UploadRecordLink[] = [];
    await Promise.all(
      folders
        .filter((folder) => folder.files.includes(uploadRecordFileName(folder.video)))
        .map(async (folder) => {
          try {
            const file = await resolve(`${folder.folder}/${uploadRecordFileName(folder.video)}`);
            const record = parseUploadRecord(await files.readText(file.path, UPLOAD_RECORD_MAX_BYTES));
            if (record) uploadRecords.push({ video: folder.video, videoId: record.videoId });
          } catch {
            // skipped
          }
        }),
    );
    return { status: "ok", folders, registry, uploadRecords };
  };
}
