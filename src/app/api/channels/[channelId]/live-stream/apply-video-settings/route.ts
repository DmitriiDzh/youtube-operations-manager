import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, type LiveStreamRouteDeps } from "../shared";

// BL-186 stage 3 (LIVE_STREAMS_FIELDS_PLAN.md §2.2) «Применить снова»: GET is the dry run (what would be sent to the running
// broadcast's video, no YouTube call); POST sends the saved video settings again -- YouTube writes, only with Live writes on and
// the identity check passed.
export function createApplyVideoSettingsGetHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId }) => NextResponse.json(await core.previewApplyVideoSettings(channelId)));
}

export function createApplyVideoSettingsPostHandler(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return liveStreamHandler(deps, async ({ core, channelId, userId }) => NextResponse.json(await core.applyVideoSettings(channelId, { userId })));
}

export const GET = createApplyVideoSettingsGetHandler();
export const POST = createApplyVideoSettingsPostHandler();
