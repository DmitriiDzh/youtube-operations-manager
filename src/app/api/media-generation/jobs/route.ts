import { NextResponse } from "next/server";
import { createChannelAccessCore } from "@/lib/channel-access";
import { assertConnectedChannel, bodyRecord, defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../shared";

// Phase 14 slice 3 -- jobs inside a running session. GET lists (optionally by session/channel);
// POST is the OPERATOR's own job (an agent's arrives through MCP in slice 5): parameters are
// validated, the prompt submitted to ComfyUI and the poll/transfer runs in the background. The body's
// channelId must be a connected channel (AGENTS.md §F); the session must belong to it (checked by the core).

/**
 * `?scope=active` (BL-157, SERVERS_MEDIA_PLAN.md AC-SM-03, ADR 0004 (b)): Media → Jobs lists only the session's ACTIVE
 * channel's jobs, the channel resolved here (never taken from the request); none while no channel is active.
 */
export function createJobsGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps(), activeChannelOf: (userId: string) => Promise<string | null> = (userId) => createChannelAccessCore().getActiveChannelId(userId)) {
  return mediaHandler(deps, async ({ core, request, userId }) => {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    if (url.searchParams.get("scope") === "active") {
      const active = await activeChannelOf(userId);
      return NextResponse.json({ jobs: active ? await core.listJobs({ ...(sessionId ? { sessionId } : {}), channelId: active }) : [] });
    }
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
    // BL-157 (review round 3): only the factory links a job to a plan (checked, under the plan's lock); never from here.
    const { plan: _plan, ...own } = input;
    void _plan;
    return NextResponse.json({ job: await core.createJob({ ...own, createdBy: "operator" }) }, { status: 201 });
  });
}

export const GET = createJobsGetHandler();
export const POST = createJobsPostHandler();
