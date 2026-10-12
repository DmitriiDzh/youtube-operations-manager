import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, readJsonBody, type LiveStreamRouteDeps } from "../shared";

// BL-176 (§3.4): add a video to the rotation (public-only guard, file checks) / set the rotation's order. Local only.
export function createRotationPostHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.addVideo(channelId, body.body), { status: 201 });
  });
}

export function createRotationPutHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    await core.reorder(channelId, body.body);
    return NextResponse.json({ ok: true });
  });
}

export const POST = createRotationPostHandler();
export const PUT = createRotationPutHandler();
