import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMediaGenerationCore, type MediaGenerationCore } from "@/lib/media-generation";
import { getOperationRegistry, isOperationAlreadyRunning, runTrackedOperation, type OperationRegistry } from "@/lib/operation-progress";
import { mediaErrorResponse } from "../../../shared";

export const MEDIA_SESSION_START_OPERATION_KIND = "media_session_start";

type Deps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<MediaGenerationCore, "approveAndStartSession" | "getSession">;
  registry: OperationRegistry;
};

// Web-UI ONLY -- the one way a generation session is approved and its pod started (no MCP tool or CLI
// command reaches the underlying action; fenced by session-approval-inventory.test.ts). The caller's
// session user is recorded as the approver and the request BLOCKS behind the shared progress pop-up
// until ComfyUI answers (or the start fails and the pod is terminated).
export function createSessionApproveHandlers(
  deps: Deps = {
    getSession: () => getServerSession(authOptions),
    core: createMediaGenerationCore(),
    registry: getOperationRegistry(),
  }
) {
  return {
    async POST(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
      const session = await deps.getSession();
      if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        const { sessionId } = await params;
        const current = await deps.core.getSession({ sessionId });
        const result = await runTrackedOperation({
          registry: deps.registry,
          kind: MEDIA_SESSION_START_OPERATION_KIND,
          channelId: current.channelId,
          title: "Starting a generation session",
          cancellable: false,
          work: (progress) => deps.core.approveAndStartSession({ sessionId, approvedByUserId: session.user?.id ?? null, onStage: (text) => progress.stage(text) }),
          messageFor: (s) => `Pod ${s.podId} is running (${s.costPerHr ?? "?"} $/h)`,
        });
        return NextResponse.json({ session: result });
      } catch (error) {
        if (isOperationAlreadyRunning(error)) {
          return NextResponse.json({ error: "operation_already_running", message: error.message, details: { operationId: error.operationId } }, { status: 409 });
        }
        return mediaErrorResponse(error);
      }
    },
  };
}

export const POST = createSessionApproveHandlers().POST;
