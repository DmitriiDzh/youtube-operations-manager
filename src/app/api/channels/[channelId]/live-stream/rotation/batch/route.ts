import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, readJsonBody, type LiveStreamRouteDeps } from "../../shared";

// BL-187 (LIVE_STREAMS_FIELDS_PLAN.md §2.4): «Добавить N видео» -- each item added with every check of the single add, in
// order; the answer lists what was added and what was refused (with why). Local only: nothing is written to YouTube.
export function createRotationBatchPostHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.addVideos(channelId, body.body));
  });
}

export const POST = createRotationBatchPostHandler();
