import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, type LiveStreamRouteDeps } from "../../shared";

// BL-187 (LIVE_STREAMS_FIELDS_PLAN.md §2.4): the «Добавить видео…» dialog's list -- the channel workspace's `04 Videos/`
// matched to the channel's videos. Read-only; `?all=1` lists source clips and folders without a V-number too.
export function createRotationCandidatesGetHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, request }) => {
    const showAll = new URL(request.url).searchParams.get("all") === "1";
    return NextResponse.json(await core.listCandidates(channelId, { showAll }));
  });
}

export const GET = createRotationCandidatesGetHandler();
