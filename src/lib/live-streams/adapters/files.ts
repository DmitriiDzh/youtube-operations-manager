import { detectFfmpeg, probeMedia, type FfmpegTools } from "@/lib/ffmpeg-host";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveWorkspaceFile } from "@/lib/workspace-exchange";
import type { LiveStreamsDependencies } from "../services";

// BL-176 (LIVE_STREAMS_PLAN.md §3.4/§3.5): a rotation video's original, named relative to the channel workspace and proven
// inside it after symlinks (the shared `workspace-exchange` rule), and probed with ffprobe (`ffmpeg-host`).

type WorkspaceLookup = (channelId: string) => Promise<{ configured: false } | { configured: true; path: string }>;

export function createLiveStreamsFiles(getWorkspace: WorkspaceLookup): LiveStreamsDependencies["files"] {
  let tools: Promise<FfmpegTools | null> | null = null;
  return {
    async resolveOriginal(channelId, relativePath) {
      const workspace = await getWorkspace(channelId);
      if (!workspace.configured) return { ok: false, workspaceMissing: true, detail: "This channel has no workspace folder on this computer (Settings → Channels)" };
      try {
        const file = await resolveWorkspaceFile({
          workspace: workspace.path,
          relativePath,
          fs: createExchangeFs(),
          validateWorkspacePath: validateOperatorDirectoryPath,
          isPathInsideOrEqual,
          unavailable: (reason) => new Error(reason),
        });
        return { ok: true, path: file.path, bytes: file.bytes };
      } catch (error) {
        return { ok: false, workspaceMissing: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
    async probe(path) {
      tools ??= detectFfmpeg();
      const found = await tools;
      if (!found) {
        tools = null; // look again next time (ffmpeg may be installed meanwhile)
        throw new Error("ffmpeg/ffprobe is not installed on this computer");
      }
      return probeMedia(found, path);
    },
  };
}
