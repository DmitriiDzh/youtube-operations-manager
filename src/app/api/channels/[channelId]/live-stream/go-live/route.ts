import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, type LiveStreamRouteDeps } from "../shared";

// BL-176 (§3.9): the picture arrives but the broadcast is not live -- the owner asks YouTube for `live`. A YouTube write.
export function createGoLivePostHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, userId }) => NextResponse.json(await core.goLive(channelId, { userId })));
}

export const POST = createGoLivePostHandler();
