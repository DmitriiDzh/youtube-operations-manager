import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, readJsonBody, type LiveStreamRouteDeps } from "../shared";

// BL-207 (LIVE_LOCALIZATIONS_PLAN.md §2 stage 4/5): the stream's title/description translations -- one set per stream, written to
// every broadcast and segment after Start as part of the video settings. Local only: neither method calls YouTube. PUT replaces
// the set (`{ localizations }`; `{}` clears); any refused language refuses the whole call (400 `validation_failed`,
// `details.refused`), nothing is half-saved; no stream on this computer is 404 `live_stream_not_found`.
export function createLiveStreamLocalizationsHandlers(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return {
    GET: liveStreamHandler(deps, async ({ core, channelId }) => NextResponse.json(await core.getLocalizations(channelId))),
    PUT: liveStreamHandler(deps, async ({ core, channelId, request }) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const localizations = body.body && typeof body.body === "object" && !Array.isArray(body.body) ? (body.body as Record<string, unknown>).localizations : undefined;
      return NextResponse.json(await core.saveLocalizations(channelId, localizations));
    }),
  };
}

const handlers = createLiveStreamLocalizationsHandlers();
export const GET = handlers.GET;
export const PUT = handlers.PUT;
