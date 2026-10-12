import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, readJsonBody, type LiveStreamRouteDeps } from "../shared";

// BL-176 (§3.9): the texts, privacy, made-for-kids and order used by the next Start. Local only.
export function createLiveStreamSettingsPutHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.saveSettings(channelId, body.body));
  });
}

export const PUT = createLiveStreamSettingsPutHandler();
