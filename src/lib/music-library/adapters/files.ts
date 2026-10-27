import path from "node:path";
import { resolveWorkspaceFile, type ExchangeReadFs } from "@/lib/workspace-exchange";
import { MUSIC_LIBRARY_MAX_BYTES, MUSIC_LIBRARY_RELATIVE_PATH, type MusicLibraryFilesPort } from "../contracts";

// BL-229 part A (MUSIC_LIBRARY_PLAN.md §2): the snapshot is read where it is, by the shared workspace-exchange rule for a channel's
// own file (`resolveWorkspaceFile`: a sound relative path, the REAL file -- symlinks resolved -- strictly inside the workspace, a
// regular file). Read-only: nothing is created. Every dependency is injected, so the real rules are tested on a temporary folder.

/** The refusal `resolveWorkspaceFile` raises; any other error is unexpected and is not turned into "unreadable". */
class SnapshotUnavailable extends Error {}

export type MusicLibraryFilesDeps = {
  fs: ExchangeReadFs;
  validateWorkspacePath(candidate: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  isPathInsideOrEqual(parent: string, child: string): boolean;
  readFile(filePath: string): Promise<string>;
  maxBytes?: number;
};

export function createMusicLibraryFiles(deps: MusicLibraryFilesDeps): MusicLibraryFilesPort {
  const maxBytes = deps.maxBytes ?? MUSIC_LIBRARY_MAX_BYTES;
  return {
    async read(workspace) {
      const validation = await deps.validateWorkspacePath(workspace);
      if (!validation.ok) return { kind: "workspace_unavailable", reason: validation.reason };
      const realWorkspace = await deps.fs.realpath(workspace).catch(() => null);
      if (!realWorkspace) return { kind: "workspace_unavailable", reason: "the workspace folder does not exist or is not accessible" };

      // Nothing at the path at all (not even a link) = the factory has not sent the snapshot yet.
      let present: boolean;
      try {
        present = (await deps.fs.lstat(path.join(realWorkspace, ...MUSIC_LIBRARY_RELATIVE_PATH.split("/")))) !== null;
      } catch (error) {
        return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
      }
      if (!present) return { kind: "missing" };

      let resolved: { path: string; bytes: number };
      try {
        resolved = await resolveWorkspaceFile({
          workspace,
          relativePath: MUSIC_LIBRARY_RELATIVE_PATH,
          fs: deps.fs,
          validateWorkspacePath: deps.validateWorkspacePath,
          isPathInsideOrEqual: deps.isPathInsideOrEqual,
          unavailable: (reason) => new SnapshotUnavailable(reason),
        });
      } catch (error) {
        if (error instanceof SnapshotUnavailable) return { kind: "refused", reason: error.message };
        throw error;
      }
      if (resolved.bytes > maxBytes) return { kind: "refused", reason: `the file is larger than ${maxBytes} bytes` };
      return { kind: "text", text: await deps.readFile(resolved.path) };
    },
  };
}
