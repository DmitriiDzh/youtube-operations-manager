import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, seqParam, type LiveStreamRouteDeps } from "../../../shared";

// BL-234: a library segment's poster (`seg-<seq>.jpg`) for the owner's list. Read-only, through the workspace rule.
export function createLibraryPosterGetHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, params }) => {
    const seq = seqParam(params.seq);
    if (seq === null) return NextResponse.json({ error: "validation_failed", message: "A segment number (seq) is required" }, { status: 400 });
    const bytes = await core.readLibraryPoster(channelId, seq);
    if (!bytes) return NextResponse.json({ error: "not_found", message: "The segment has no poster" }, { status: 404 });
    return new NextResponse(Buffer.from(bytes), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=300" } });
  });
}

export const GET = createLibraryPosterGetHandler();
