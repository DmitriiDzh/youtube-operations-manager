import { NextResponse } from "next/server";
import { defaultLiveStreamRouteDeps, liveStreamHandler, readJsonBody, type LiveStreamRouteDeps } from "../shared";

// BL-234 (FO-REQ-0048, ADR 0056): the channel's segment library (GET, read-only) and the stream's selection from it -- add segments at
// the end (POST { seqs }) or set the selection's order (PUT { seqs }). Local only: no library file is ever written or deleted.
export function createLibraryHandlers(deps: LiveStreamRouteDeps = defaultLiveStreamRouteDeps()) {
  return {
    GET: liveStreamHandler(deps, async ({ core, channelId }) => NextResponse.json(await core.listLibrary(channelId))),
    POST: liveStreamHandler(deps, async ({ core, channelId, request }) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      return NextResponse.json(await core.addSegments(channelId, body.body), { status: 201 });
    }),
    PUT: liveStreamHandler(deps, async ({ core, channelId, request }) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      await core.reorderSegments(channelId, body.body);
      return NextResponse.json({ ok: true });
    }),
  };
}

const handlers = createLibraryHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
export const PUT = handlers.PUT;
