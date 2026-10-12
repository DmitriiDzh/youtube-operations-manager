import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, readJsonBody, type LiveStreamRouteDeps } from "../shared";

// BL-176 (§3.9) Edit: `{ patch, expected }` -- refused if the broadcast changed since the preview; written, read back, and
// both versions recorded. A YouTube write, with Live writes and the identity check.
export function createEditPostHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, userId, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.edit(channelId, { userId }, body.body));
  });
}

export const POST = createEditPostHandler();
