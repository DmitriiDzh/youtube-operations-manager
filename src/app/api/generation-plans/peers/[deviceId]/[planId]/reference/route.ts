import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createGenerationPlansCore } from "@/lib/generation-plans";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveSentToYtmFile } from "@/lib/workspace-exchange";
import { createReferenceGetHandler } from "../../../../[planId]/audition/serve";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const unavailable = (reason: string) => new Error(reason);

/** BL-143 phase 3: a reference of ANOTHER device's plan, named by its report, from THIS device's copy of the channel folder. */
export async function GET(request: Request, context: { params: Promise<{ deviceId: string; planId: string }> }) {
  const { deviceId, planId } = await context.params;
  const handler = createReferenceGetHandler({
    getSession: () => getServerSession(authOptions),
    resolveReference: (input) => createGenerationPlansCore().resolvePeerReference({ ...input, deviceId }),
    async workspaceOf(channelId) {
      const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
      return workspace.configured ? workspace.path : null;
    },
    resolveSentFile: (workspace, relativePath) => resolveSentToYtmFile({ workspace, relativePath, fs: createExchangeFs(), validateWorkspacePath: validateOperatorDirectoryPath, isPathInsideOrEqual, unavailable }),
    resolveJobFile: async () => {
      throw new Error("a reference is never a job output");
    },
  });
  return handler(request, { params: Promise.resolve({ planId }) });
}
