import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, readJsonBody, type LiveStreamRouteDeps } from "../shared";

// BL-234 (FO-REQ-0048, ADR 0056): the owner's switch of what the stream plays -- `videos` (the rotation) or `segments` (the selection
// from the segment library). A Web session and the active channel only: no MCP or agent tool reaches it. Local only; it applies at the
// next pass (or at once with Restart, or at the next Start).
export function createSourceModePutHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.setSourceMode(channelId, body.body));
  });
}

export const PUT = createSourceModePutHandler();
