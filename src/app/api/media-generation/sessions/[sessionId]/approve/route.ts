import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaParamsHandler, type MediaRouteDeps } from "../../../shared";

// Web-UI ONLY -- the one way a generation session is approved and its pod started (no MCP tool or CLI
// command reaches the underlying action; fenced by session-approval-inventory.test.ts). The caller's
// session user is recorded as the approver.
//
// Slice 6 (owner, 2026-10-05: no blocking pop-up, several sessions at once -- AC-P14-24): the preconditions and
// the `pending -> approved` step run in this request, which answers at once with the `approved` session; the pod
// start continues in the background and its progress and outcome are read from the session row (Production →
// Sessions polls it). A failure of the start lands on the row (`failed`/`stopping` + error), never only in a log.
export function createSessionApproveHandler(deps: MediaRouteDeps = defaultMediaRouteDeps(), log: (line: string) => void = (line) => console.warn(line)) {
  return mediaParamsHandler<{ sessionId: string }>(deps, async ({ core, params, userId }) => {
    const { session, started } = await core.approveSession({ sessionId: params.sessionId, approvedByUserId: userId });
    void started.catch((error: unknown) => log(`[media] session ${params.sessionId} start failed: ${error instanceof Error ? error.message : String(error)}`));
    return NextResponse.json({ session }, { status: 202 });
  });
}

export const POST = createSessionApproveHandler();
