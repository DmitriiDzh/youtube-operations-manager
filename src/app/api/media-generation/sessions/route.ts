import { NextResponse } from "next/server";
import { assertConnectedChannel, bodyRecord, defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../shared";

// Phase 14 slice 2 -- sessions (docs/roadmap/plans/PHASE_14_PLAN.md §2.3). GET: recent sessions +
// limits (spend today, cap, the open session). POST: the OPERATOR's own request (an agent's request
// arrives through MCP in slice 5); creating one makes no RunPod call and costs nothing. The body's
// channelId must be a connected channel (AGENTS.md §F) -- the MCP path asserts the bound channel instead.

export function createSessionsGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => {
    const [sessions, limits] = await Promise.all([core.listSessions(50), core.getLimits()]);
    return NextResponse.json({ sessions, limits });
  });
}

export function createSessionsPostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request, deps: routeDeps }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = bodyRecord(body.body);
    await assertConnectedChannel(routeDeps, input.channelId);
    // BL-157 (review round 6): only the factory links a session to a plan (checked by the plans module) -- never from here.
    // BL-159 (review): a session's own minimum host CUDA is the factory's too (the Web UI neither sets nor shows it).
    const { planId: _planId, minCudaVersion: _minCudaVersion, ...own } = input;
    void _planId;
    void _minCudaVersion;
    const session = await core.requestSession({ ...own, requestedBy: "operator" });
    return NextResponse.json({ session }, { status: 201 });
  });
}

export const GET = createSessionsGetHandler();
export const POST = createSessionsPostHandler();
