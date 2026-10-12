import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, readJsonBody, type LiveStreamRouteDeps } from "../../../shared";

// BL-176 (§3.4): the owner's override of the public-only guard for one rotation video, with a reason (audited), and its removal.
export function createOverridePostHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, params, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    await core.overrideGuard(channelId, params.videoId, body.body);
    return NextResponse.json({ ok: true });
  });
}

export function createOverrideDeleteHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, params }) => {
    await core.clearGuardOverride(channelId, params.videoId);
    return NextResponse.json({ ok: true });
  });
}

export const POST = createOverridePostHandler();
export const DELETE = createOverrideDeleteHandler();
