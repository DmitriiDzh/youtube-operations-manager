import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, type LiveStreamRouteDeps } from "../shared";

// BL-176 (§3.9) Restart: the encoder restarts on the same broadcast (rotation edits apply now). No YouTube write.
export function createRestartPostHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId }) => NextResponse.json(await core.restart(channelId)));
}

export const POST = createRestartPostHandler();
