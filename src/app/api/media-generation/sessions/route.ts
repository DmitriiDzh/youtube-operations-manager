import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../shared";

// Phase 14 slice 2 -- sessions (docs/roadmap/plans/PHASE_14_PLAN.md §2.3). GET: recent sessions +
// limits (spend today, cap, the open session). POST: the OPERATOR's own request (an agent's request
// arrives through MCP in slice 5); creating one makes no RunPod call and costs nothing.

export function createSessionsGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => {
    const [sessions, limits] = await Promise.all([core.listSessions(50), core.getLimits()]);
    return NextResponse.json({ sessions, limits });
  });
}

export function createSessionsPostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = body.body && typeof body.body === "object" ? (body.body as Record<string, unknown>) : {};
    const session = await core.requestSession({ ...input, requestedBy: "operator" });
    return NextResponse.json({ session }, { status: 201 });
  });
}

export const GET = createSessionsGetHandler();
export const POST = createSessionsPostHandler();
