import path from "node:path";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createGenerationPlansCore } from "@/lib/generation-plans";
import { activeChannelOf } from "../../../../shared";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { MEDIA_OUTPUT_SUBDIR } from "@/lib/media-generation/contracts";
import { createExchangeFs, DATA_EXCHANGE_DIR_NAME, FROM_YTM_DIR_NAME, resolveFromYtmJobFile, resolveSentToYtmFile } from "@/lib/workspace-exchange";
import { createRecheckAuditionGetHandler } from "../../../../[planId]/audition/serve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const unavailable = (reason: string) => new Error(reason);

/** BL-173 (§2.7): a re-check of ANOTHER device's plan, named by its report, played from THIS device's copy of the channel folder. */
export async function GET(request: Request, context: { params: Promise<{ deviceId: string; planId: string }> }) {
  const { deviceId, planId } = await context.params;
  const handler = createRecheckAuditionGetHandler({
    getSession: () => getServerSession(authOptions),
    assertVisible: async (userId) => createGenerationPlansCore().assertPeerPlanOfChannel(deviceId, planId, await activeChannelOf(userId)),
    resolveRecheck: (input) => createGenerationPlansCore().resolvePeerRecheckAudition({ ...input, deviceId }),
    async workspaceOf(channelId) {
      const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
      return workspace.configured ? workspace.path : null;
    },
    resolveSentFile: (workspace, relativePath) => resolveSentToYtmFile({ workspace, relativePath, fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable }),
    // The report names `media/<jobId>/<file>` relative to From YTM; the resolver proves the result stays in that job folder.
    resolveJobFile: (workspace, jobId, relative) =>
      resolveFromYtmJobFile({ workspace, subdir: MEDIA_OUTPUT_SUBDIR, jobId, filePath: path.join(workspace, DATA_EXCHANGE_DIR_NAME, FROM_YTM_DIR_NAME, ...relative.split("/")), fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable }),
  });
  return handler(request, { params: Promise.resolve({ planId }) });
}
