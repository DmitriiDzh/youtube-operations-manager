import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, readJsonBody, type LiveStreamRouteDeps } from "../../shared";

// BL-176 (§3.9) Edit, step 1: the broadcast's title, description and privacy as YouTube has them, and what they would become.
export function createEditPreviewHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, userId, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.previewEdit(channelId, { userId }, body.body));
  });
}

export const POST = createEditPreviewHandler();
