import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, seqParam, type LiveStreamRouteDeps } from "../../shared";

// BL-234: removes a segment from the stream's selection only -- the library file stays. Applied at the next pass (or now, with Restart).
export function createLibrarySegmentDeleteHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, params }) => {
    const seq = seqParam(params.seq);
    if (seq === null) return NextResponse.json({ error: "validation_failed", message: "A segment number (seq) is required" }, { status: 400 });
    await core.removeSegment(channelId, seq);
    return NextResponse.json({ ok: true });
  });
}

export const DELETE = createLibrarySegmentDeleteHandler();
