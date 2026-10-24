import { readFile } from "node:fs/promises";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { getSpendJobOutputs } from "@/lib/db";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createImagePreviewerForProduction } from "@/lib/media-preview";
import { createExchangeFs, resolveFromYtmJobFile } from "@/lib/workspace-exchange";
import { createPreviewHandler } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-219: a preview of one image output of this computer's job, for Servers → «Аналитика» (AC-SA-09).
export const GET = createPreviewHandler({
  getSession: () => getServerSession(authOptions),
  jobOutputs: (source, jobId) => getSpendJobOutputs(source, jobId),
  async workspaceOf(channelId) {
    const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
    return workspace.configured ? workspace.path : null;
  },
  resolveJobFile: (workspace, subdir, jobFolder, filePath) =>
    resolveFromYtmJobFile({ workspace, subdir, jobId: jobFolder, filePath, fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable: (reason) => new Error(reason) }),
  preview: (path) => createImagePreviewerForProduction().preview(path),
  readFile: async (path) => new Uint8Array(await readFile(path)),
});
