import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, type LiveStreamRouteDeps } from "../../shared";

// BL-176 (§3.4): remove a video from the rotation. Local only; applied at the next pass (or now, with Restart).
export function createRotationVideoDeleteHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, params }) => {
    await core.removeVideo(channelId, params.videoId);
    return NextResponse.json({ ok: true });
  });
}

export const DELETE = createRotationVideoDeleteHandler();
