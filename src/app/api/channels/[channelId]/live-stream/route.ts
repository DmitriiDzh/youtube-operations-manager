import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, type LiveStreamRouteDeps } from "./shared";

// BL-176 (LIVE_STREAMS_PLAN.md §3.10/§3.12): the channel's stream page -- settings, rotation, buffer sources, the encoder's
// state, the Start preview and the recent history. A read; never the key.
export function createLiveStreamGetHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId }) => NextResponse.json(await core.overview(channelId)));
}

export const GET = createLiveStreamGetHandler();
