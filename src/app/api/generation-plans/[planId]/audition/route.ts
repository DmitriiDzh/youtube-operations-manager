import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createGenerationPlansCore } from "@/lib/generation-plans";
import { activeChannelOf } from "../../shared";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { MEDIA_OUTPUT_SUBDIR } from "@/lib/media-generation/contracts";
import { createExchangeFs, resolveFromYtmJobFile, resolveSentToYtmFile } from "@/lib/workspace-exchange";
import { createAuditionGetHandler } from "./serve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const unavailable = (reason: string) => new Error(reason);

/** BL-143 (AC-GP-14): the file of one plan attempt for the review player (`?itemKey=&attemptRef=`), with Range support. */
export const GET = createAuditionGetHandler({
  getSession: () => getServerSession(authOptions),
  assertVisible: async (userId, planId) => createGenerationPlansCore().assertPlanOfChannel(planId, await activeChannelOf(userId)),
  resolveAudition: (input) => createGenerationPlansCore().resolveAudition(input),
  async workspaceOf(channelId) {
    const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
    return workspace.configured ? workspace.path : null;
  },
  resolveSentFile: (workspace, relativePath) => resolveSentToYtmFile({ workspace, relativePath, fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable }),
  resolveJobFile: (workspace, jobId, filePath) => resolveFromYtmJobFile({ workspace, subdir: MEDIA_OUTPUT_SUBDIR, jobId, filePath, fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable }),
});
