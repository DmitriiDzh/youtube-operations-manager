import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, readJsonBody, type LiveStreamRouteDeps } from "../shared";

// BL-205 (LIVE_SEGMENTS_PLAN.md §2.1): the stream's segment settings («Перезапуск эфира»). Local only; the switches themselves
// are made by the server's runner while the setting is on.
export function createLiveStreamSegmentsPutHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.saveSegments(channelId, body.body));
  });
}

export const PUT = createLiveStreamSegmentsPutHandler();
