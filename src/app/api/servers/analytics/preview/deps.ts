import { readFile } from "node:fs/promises";
import path from "node:path";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { getSpendJobOutputs } from "@/lib/db";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createImagePreviewerForProduction } from "@/lib/media-preview";
import { createExchangeFs, DATA_EXCHANGE_DIR_NAME, FROM_YTM_DIR_NAME, resolveFromYtmJobFile } from "@/lib/workspace-exchange";
import type { PreviewDeps } from "./handlers";


// BL-219: the real dependencies of the preview route (AC-SA-09); `resolveJobFile` is tested against a real folder.
export const previewDeps: PreviewDeps = {
  getSession: () => getServerSession(authOptions),
  jobOutputs: (source, jobId) => getSpendJobOutputs(source, jobId),
  async workspaceOf(channelId) {
    const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
    return workspace.configured ? workspace.path : null;
  },
  // Review (BL-219): the resolver takes the file's FULL path (it proves the real file stays inside the job folder), not a bare name.
  resolveJobFile: (workspace, subdir, jobFolder, fileName) =>
    resolveFromYtmJobFile({ workspace, subdir, jobId: jobFolder, filePath: path.join(workspace, DATA_EXCHANGE_DIR_NAME, FROM_YTM_DIR_NAME, subdir, jobFolder, ...fileName.split("/")), fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable: (reason) => new Error(reason) }),
  preview: (path) => createImagePreviewerForProduction().preview(path),
  readFile: async (path) => new Uint8Array(await readFile(path)),
};
