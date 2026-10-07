import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createGenerationPlansCore } from "@/lib/generation-plans";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveSentToYtmFile } from "@/lib/workspace-exchange";
import { createReferenceGetHandler } from "../audition/serve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const unavailable = (reason: string) => new Error(reason);

/** BL-143 phase 3 (FO-MSG-0009): a plan reference track for A/B (`?id=`), from the channel's Sent to YTM, with Range. */
export const GET = createReferenceGetHandler({
  getSession: () => getServerSession(authOptions),
  resolveReference: (input) => createGenerationPlansCore().resolveReference(input),
  async workspaceOf(channelId) {
    const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
    return workspace.configured ? workspace.path : null;
  },
  resolveSentFile: (workspace, relativePath) => resolveSentToYtmFile({ workspace, relativePath, fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable }),
  resolveJobFile: async () => {
    throw new Error("a reference is never a job output");
  },
});
