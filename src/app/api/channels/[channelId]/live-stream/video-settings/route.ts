import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, readJsonBody, type LiveStreamRouteDeps } from "../shared";

// BL-186 (LIVE_STREAMS_FIELDS_PLAN.md §2.2): the stream's video and broadcast settings used by the next Start. Local only.
export function createLiveStreamVideoSettingsPutHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.saveVideoSettings(channelId, body.body));
  });
}

export const PUT = createLiveStreamVideoSettingsPutHandler();
