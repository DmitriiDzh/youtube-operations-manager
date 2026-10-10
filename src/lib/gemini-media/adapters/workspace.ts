import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveFromYtmDir, resolveSentToYtmFile } from "@/lib/workspace-exchange";
import { DomainError } from "../contracts";
import type { GeminiWorkspacePort } from "../services";

// BL-174 (GEMINI_MEDIA_PLAN.md §2.4): where a channel's Gemini files live. Outputs: the channel workspace's
// `99 Data Exchange/From YTM` (created if missing, proven inside the workspace). Inputs: a path relative to its `Sent to YTM`,
// proven contained after symlinks and a regular file (the shared `workspace-exchange` rules, the same ones media jobs use).
// `getWorkspace` is injected so the real rules can be tested on a temporary folder (review round 1).

type WorkspaceLookup = (channelId: string) => Promise<{ configured: false } | { configured: true; path: string }>;

export function createGeminiWorkspace(getWorkspace: WorkspaceLookup): GeminiWorkspacePort {
  return {
    async resolveOutputRoot(channelId) {
      const workspace = await getWorkspace(channelId);
      if (!workspace.configured) {
        throw new DomainError({ code: "gemini_workspace_unavailable", message: "This channel has no workspace folder on this computer (Settings → Channels); Gemini outputs are written only there.", details: { channelId } });
      }
      return resolveFromYtmDir({
        workspace: workspace.path,
        fs: createExchangeFs(),
        validateWorkspacePath: validateOperatorDirectoryPath,
        isPathInsideOrEqual,
        unavailable: (reason) => new DomainError({ code: "gemini_workspace_unavailable", message: `The channel's workspace folder cannot receive outputs: ${reason}`, details: { channelId, reason } }),
      });
    },
    async resolveInput(channelId, relativePath) {
      const workspace = await getWorkspace(channelId);
      const unavailable = (reason: string) => new DomainError({ code: "gemini_input_unavailable", message: `Input ${relativePath}: ${reason}`, details: { channelId, path: relativePath, reason } });
      if (!workspace.configured) throw unavailable("this channel has no workspace folder on this computer (Settings → Channels)");
      return resolveSentToYtmFile({ workspace: workspace.path, relativePath, fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable });
    },
  };
}
