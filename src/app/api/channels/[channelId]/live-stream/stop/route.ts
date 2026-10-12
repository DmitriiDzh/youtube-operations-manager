import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, readJsonBody, type LiveStreamRouteDeps } from "../shared";

// BL-176 (§3.9) Stop: end the broadcast on YouTube (a write), stop the encoder, turn the intent off. `{ encoderOnly: true }`
// stops only the encoder (no write): the broadcast stays open on YouTube without a picture.
export function createStopPostHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, userId, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.stop(channelId, { userId }, body.body));
  });
}

export const POST = createStopPostHandler();
