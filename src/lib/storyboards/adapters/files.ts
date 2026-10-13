import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveExchangeFile } from "@/lib/workspace-exchange";
import { STORYBOARD_JOB_OUTPUT_SUBDIRS, type StoryboardFilesPort } from "../contracts";

// BL-184 (STORYBOARD_PLAN.md §2.3): keyframe files are read where they are in the channel's `99 Data Exchange` -- `Sent to YTM/`, or
// a Gemini / GPU media job's own `From YTM/<subdir>/<jobId>/` folder -- by the shared workspace-exchange rules (the same ones plan
// auditions use): plain folders, the real file inside, a regular file. Nothing is copied. `getWorkspace` is injected so the real
// rules can be tested on a temporary folder.

type WorkspaceLookup = (channelId: string) => Promise<{ configured: false } | { configured: true; path: string }>;

export function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export function createStoryboardFiles(getWorkspace: WorkspaceLookup): StoryboardFilesPort {
  return {
    async workspaceOf(channelId) {
      const workspace = await getWorkspace(channelId);
      return workspace.configured ? workspace.path : null;
    },
    resolve: (workspace, relativePath) =>
      resolveExchangeFile({
        workspace,
        relativePath,
        jobSubdirs: STORYBOARD_JOB_OUTPUT_SUBDIRS,
        fs: createExchangeFs(),
        validateWorkspacePath: validateOperatorDirectoryPath,
        isPathInsideOrEqual,
        unavailable: (reason) => new Error(reason),
      }),
    sha256: sha256OfFile,
  };
}
