import path from "node:path";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveWorkspaceFile } from "@/lib/workspace-exchange";
import { createWorkspaceVideoFiles, listVideoFolders, parseVideoRegistry, VIDEO_REGISTRY_FILE, VIDEOS_FOLDER, type VideoRegistryRow } from "@/lib/workspace-videos";
import type { WorkspaceVideos } from "../contracts";

/** The registry is a few kilobytes per hundred rows. */
const REGISTRY_MAX_BYTES = 4 * 1024 * 1024;

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
    let registry: VideoRegistryRow[] = [];
    try {
      const file = await resolveWorkspaceFile({
        workspace: workspace.path,
        relativePath: `${VIDEOS_FOLDER}/${VIDEO_REGISTRY_FILE}`,
        fs: createExchangeFs(),
        validateWorkspacePath: validateOperatorDirectoryPath,
        isPathInsideOrEqual,
        unavailable: (reason) => new Error(reason),
      });
      registry = parseVideoRegistry(await files.readText(file.path, REGISTRY_MAX_BYTES));
    } catch {
      registry = []; // no registry (or an unreadable one) is not an error: the factory may not keep one
    }
    return { status: "ok", folders, registry };
  };
}
