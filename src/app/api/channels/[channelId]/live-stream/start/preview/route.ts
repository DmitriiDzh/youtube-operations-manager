import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, type LiveStreamRouteDeps } from "../../shared";

// BL-176 (§3.9): the Start dialog's dry run -- exactly what Start will send, and its quota units. No YouTube call.
export function createStartPreviewHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId }) => NextResponse.json(await core.previewStart(channelId)));
}

export const POST = createStartPreviewHandler();
