import { NextResponse } from "next/server";
import { assertConnectedChannel, bodyRecord, defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../shared";

// Phase 14 slice 3 -- jobs inside a running session. GET lists (optionally by session/channel);
// POST is the OPERATOR's own job (an agent's arrives through MCP in slice 5): parameters are
// validated, the prompt submitted to ComfyUI and the poll/transfer runs in the background. The body's
// channelId must be a connected channel (AGENTS.md §F); the session must belong to it (checked by the core).

export function createJobsGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const channelId = url.searchParams.get("channelId") ?? undefined;
    return NextResponse.json({ jobs: await core.listJobs({ ...(sessionId ? { sessionId } : {}), ...(channelId ? { channelId } : {}) }) });
  });
}

export function createJobsPostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request, deps: routeDeps }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = bodyRecord(body.body);
    await assertConnectedChannel(routeDeps, input.channelId);
    return NextResponse.json({ job: await core.createJob({ ...input, createdBy: "operator" }) }, { status: 201 });
  });
}

export const GET = createJobsGetHandler();
export const POST = createJobsPostHandler();
