import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, type LiveStreamRouteDeps } from "../shared";

// BL-176 (§3.9) Start: the stream (first time) and a broadcast are created and bound, then the encoder starts. YouTube
// writes, only with Live writes on and the identity check passed.
export function createStartPostHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, userId }) => NextResponse.json(await core.start(channelId, { userId })));
}

export const POST = createStartPostHandler();
