import { NextResponse } from "next/server";
import { getOperationRegistry, isOperationAlreadyRunning, runTrackedOperation, type OperationRegistry } from "@/lib/operation-progress";
import { defaultMediaRouteDeps, mediaParamsHandler, type MediaRouteDeps } from "../../../shared";

export const MEDIA_SESSION_START_OPERATION_KIND = "media_session_start";

// Web-UI ONLY -- the one way a generation session is approved and its pod started (no MCP tool or CLI
// command reaches the underlying action; fenced by session-approval-inventory.test.ts). The caller's
// session user is recorded as the approver and the request BLOCKS behind the shared progress pop-up
// until ComfyUI answers (or the start fails and the pod is terminated).
export function createSessionApproveHandler(deps: MediaRouteDeps = defaultMediaRouteDeps(), registry: OperationRegistry = getOperationRegistry()) {
  return mediaParamsHandler<{ sessionId: string }>(deps, async ({ core, params, userId }) => {
    try {
      const current = await core.getSession({ sessionId: params.sessionId });
      const result = await runTrackedOperation({
        registry,
        kind: MEDIA_SESSION_START_OPERATION_KIND,
        channelId: current.channelId,
        title: "Starting a generation session",
        cancellable: false,
        work: (progress) => core.approveAndStartSession({ sessionId: params.sessionId, approvedByUserId: userId, onStage: (text) => progress.stage(text) }),
        messageFor: (s) => `Pod ${s.podId} is running (${s.costPerHr ?? "?"} $/h)`,
      });
      return NextResponse.json({ session: result });
    } catch (error) {
      if (isOperationAlreadyRunning(error)) {
        return NextResponse.json({ error: "operation_already_running", message: error.message, details: { operationId: error.operationId } }, { status: 409 });
      }
      throw error;
    }
  });
}

export const POST = createSessionApproveHandler();
